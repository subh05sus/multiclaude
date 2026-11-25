import { readFileSync } from 'node:fs';
import { request } from 'node:https';
import WebSocket from 'ws';
import { isValidProfileName } from './util.ts';

const USAGE = `Usage: mc remote (profiles | ls) | (sessions | ps) PROFILE | (start | new) PROFILE | (attach | a) PROFILE [ID] | (end | rm) PROFILE [ID]
Use a full session ID or a unique prefix. Omit ID when the profile has one active session.`;
const ALIASES = new Map([
  ['ls', 'profiles'], ['ps', 'sessions'], ['new', 'start'], ['a', 'attach'], ['rm', 'end'],
]);
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const FRAME_LIMIT = 65536;
const BUFFER_LIMIT = 262144;

function connection() {
  const configured = process.env.MC_SERVER_URL ?? '';
  let server: URL;
  try {
    server = new URL(configured);
    // Reject components which URL parsing can silently normalize away.
    if (!/^https:\/\/[^/?#@\\\s]+\/?$/i.test(configured) || server.protocol !== 'https:' || server.pathname !== '/') throw new Error();
  } catch {
    throw new Error('Set MC_SERVER_URL to an HTTPS origin, such as https://mc.example.com:4881.');
  }
  let key: string;
  try {
    key = readFileSync(process.env.MC_ACCESS_KEY_FILE ?? '', 'utf8').trim();
  } catch {
    throw new Error('Set MC_ACCESS_KEY_FILE to a readable access key file.');
  }
  if (!/^[\w-]{43}$/.test(key)) throw new Error('The access key file is invalid.');
  return { server, headers: { Authorization: `Bearer ${key}` } };
}

function statusError(status?: number, attaching = false): Error {
  switch (status) {
    case 401: return new Error('The server rejected the access key.');
    case 404: return new Error('The profile or session is unavailable.');
    case 409: return new Error(attaching ? 'Another client is attached to this session.' : 'Another session is being created for this profile. Try again.');
    case 429: return new Error('This profile has reached its limit of eight active sessions.');
    case 503: return new Error('The server could not complete the operation.');
    default: return new Error('The server returned an unexpected response.');
  }
}

type Connection = ReturnType<typeof connection>;

function json({ server, headers }: Connection, method: string, path: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const networkError = () => reject(new Error('Could not communicate with the HTTPS server.'));
    const req = request(new URL(path, server), {
      method, headers, rejectUnauthorized: true,
      signal: AbortSignal.timeout(15000),
    }, res => {
      if (res.statusCode !== 200 && res.statusCode !== 201) {
        res.destroy();
        return reject(statusError(res.statusCode));
      }
      const chunks: Buffer[] = [];
      let length = 0;
      res.on('error', networkError);
      res.on('data', (chunk: Buffer) => {
        length += chunk.length;
        if (length > BUFFER_LIMIT) {
          reject(new Error('The server response is too large.'));
          return res.destroy();
        }
        chunks.push(chunk);
      });
      res.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
        catch { reject(new Error('The server returned invalid JSON.')); }
      });
    });
    req.on('error', networkError);
    req.end();
  });
}

async function attach({ server, headers }: Connection, path: string): Promise<void> {
  const { stdin, stdout } = process;
  const url = new URL(path, server);
  url.protocol = 'wss:';
  const ws = new WebSocket(url, {
    headers, rejectUnauthorized: true, followRedirects: false, handshakeTimeout: 10000,
    maxPayload: FRAME_LIMIT, perMessageDeflate: false,
  });
  const wasRaw = Boolean(stdin.isRaw);
  let raw = false;
  let attached = false;
  let done = false;
  let finish: (error?: Error) => void;

  const resize = () => {
    const clamp = (value: number, fallback: number) => Math.max(1, Math.min(4096, value || fallback));
    if (done || ws.readyState !== WebSocket.OPEN) return;
    if (ws.bufferedAmount > BUFFER_LIMIT) return finish(new Error('Terminal input is backed up.'));
    ws.send(JSON.stringify({ cols: clamp(stdout.columns, 80), rows: clamp(stdout.rows, 24) }), onSend);
  };
  const onSend = (err?: Error) => {
    if (err) finish(new Error('Could not send terminal input.'));
  };
  const detach = () => finish();
  const onInput = (chunk: Buffer) => {
    if (done || ws.readyState !== WebSocket.OPEN) return;
    const end = chunk.indexOf(0x1d); // Ctrl-]
    const bytes = end < 0 ? chunk : chunk.subarray(0, end);
    if (ws.bufferedAmount + bytes.length > BUFFER_LIMIT) return finish(new Error('Terminal input is backed up.'));
    stdin.pause();
    let offset = 0;
    function sendNext(err?: Error) {
      if (err) return onSend(err);
      if (done || ws.readyState !== WebSocket.OPEN) return;
      if (offset === bytes.length) {
        if (end >= 0) detach();
        else stdin.resume();
        return;
      }
      const frame = bytes.subarray(offset, offset + FRAME_LIMIT);
      offset += frame.length;
      ws.send(frame, sendNext);
    }
    sendNext();
  };
  const onDrain = () => { if (ws.readyState === WebSocket.OPEN) ws.resume(); };
  const onTerminalError = () => finish(new Error('The local terminal is unavailable.'));

  try {
    await new Promise<void>((resolve, reject) => {
      finish = error => {
        if (done) return;
        done = true;
        if (error) reject(error);
        else resolve();
      };
      ws.once('unexpected-response', (_request, response) => {
        finish(statusError(response.statusCode, true));
        response.destroy();
      });
      ws.on('error', () => finish(new Error('Could not connect to the remote terminal over TLS.')));
      ws.once('close', code => {
        if (!attached || code !== 1000) finish(new Error('The remote terminal disconnected. Use attach with the same session ID to reconnect.'));
        else finish();
      });
      ws.once('open', () => {
        try {
          stdin.setRawMode(true);
          raw = true;
          attached = true;
          stdin.on('data', onInput);
          stdin.on('end', detach);
          stdin.on('error', onTerminalError);
          stdout.on('error', onTerminalError);
          stdout.on('resize', resize);
          process.on('SIGINT', detach);
          process.on('SIGTERM', detach);
          if (process.platform !== 'win32') process.on('SIGHUP', detach);
          resize();
          stdin.resume();
        } catch {
          onTerminalError();
        }
      });
      ws.on('message', (bytes, binary) => {
        if (done) return;
        if (!binary || !Buffer.isBuffer(bytes)) return finish(new Error('The server sent an invalid terminal frame.'));
        if (stdout.writableLength + bytes.length > BUFFER_LIMIT) return finish(new Error('Terminal output is backed up.'));
        if (!stdout.write(bytes)) {
          ws.pause();
          stdout.off('drain', onDrain).once('drain', onDrain);
        }
      });
    });
  } finally {
    stdin.off('data', onInput).off('end', detach).off('error', onTerminalError);
    stdout.off('resize', resize).off('drain', onDrain).off('error', onTerminalError);
    process.off('SIGINT', detach).off('SIGTERM', detach);
    if (process.platform !== 'win32') process.off('SIGHUP', detach);
    if (ws.readyState === WebSocket.OPEN) {
      ws.removeAllListeners('message');
      ws.resume();
      ws.close(1000);
      const timeout = setTimeout(() => ws.terminate(), 1000);
      ws.once('close', () => clearTimeout(timeout));
    } else if (ws.readyState === WebSocket.CONNECTING) {
      ws.terminate();
    }
    if (raw) {
      stdin.pause();
      stdin.setRawMode(wasRaw);
      stdin.unref();
    }
  }
}

async function list(client: Connection, path: string, validate: (entry: string) => boolean): Promise<string[]> {
  const entries = await json(client, 'GET', path);
  if (!Array.isArray(entries) || !entries.every(entry => typeof entry === 'string' && validate(entry))) {
    throw new Error('The server returned an invalid list.');
  }
  return entries;
}

export async function remoteCommand(args: string[]): Promise<void> {
  const [command, profile, selection] = args;
  const action = ALIASES.get(command) ?? command;
  const selectsSession = action === 'attach' || action === 'end';
  const id = selection?.toLowerCase();
  const length = { profiles: 1, sessions: 2, start: 2, attach: 3, end: 3 };
  if (!Object.hasOwn(length, action) || (args.length !== length[action as keyof typeof length] && !(selectsSession && args.length === 2)) ||
    (profile !== undefined && !isValidProfileName(profile)) ||
    (id !== undefined && !ID.test(id) && !/^[0-9a-f][0-9a-f-]{0,34}$/.test(id))) throw new Error(USAGE);
  if (action === 'attach' && (!process.stdin.isTTY || !process.stdout.isTTY)) {
    throw new Error('Attaching to a remote session requires an interactive terminal.');
  }
  const client = connection();
  const collection = `/v1/profiles/${profile}/sessions`;
  switch (action) {
    case 'profiles':
      for (const name of await list(client, '/v1/profiles', isValidProfileName)) console.log(name);
      return;
    case 'sessions':
      for (const id of await list(client, collection, entry => ID.test(entry))) console.log(id);
      return;
    case 'start': {
      const result = await json(client, 'POST', collection) as { id?: unknown } | null;
      if (typeof result?.id !== 'string' || !ID.test(result.id)) throw new Error('The server returned an invalid session ID.');
      console.log(result.id);
      return;
    }
    case 'attach':
    case 'end': {
      let target = id;
      if (!target || !ID.test(target)) {
        const sessions = await list(client, collection, entry => ID.test(entry));
        const matches = id ? sessions.filter(session => session.startsWith(id)) : sessions;
        if (matches.length === 0) throw new Error('No active session matches. Run "mc remote sessions PROFILE" to list sessions.');
        if (matches.length > 1) throw new Error('Multiple active sessions match. Supply a unique ID prefix or the full session ID.');
        target = matches[0];
      }
      if (action === 'attach') {
        process.stderr.write(`Remote session ${target} (Ctrl-] to detach)\n`);
        return attach(client, `${collection}/${target}`);
      }
      await json(client, 'DELETE', `${collection}/${target}`);
      console.log('Remote session ended.');
    }
  }
}
