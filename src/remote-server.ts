import { createServer, type ServerOptions } from 'node:https';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import type { IncomingMessage } from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';
import { isValidProfileName } from './util.ts';
import { runtime, requireRootless, provision, type Profile } from './remote-runtime.ts';

interface Grant { digest: string; owner: string; profiles: string[] }
interface Config { host?: string; port: number; cert: string; key: string; grants: string; profiles: Profile[] }

export function digest(key: string) {
  return createHash('sha256').update(key).digest('hex');
}

function loadConfig(path: string): Config {
  let cfg: Config;
  try { cfg = JSON.parse(readFileSync(path, 'utf8')); } catch { throw new Error('Cannot read server configuration.'); }
  if (!cfg || !Number.isInteger(cfg.port) || cfg.port < 1 || cfg.port > 65535 ||
      (cfg.host !== undefined && (typeof cfg.host !== 'string' || !cfg.host.length)) ||
      ![cfg.cert, cfg.key, cfg.grants].every(v => typeof v === 'string' && v.length) ||
      !Array.isArray(cfg.profiles)) throw new Error('Invalid server configuration.');
  const pairs = new Set<string>();
  for (const p of cfg.profiles) {
    if (!p || ![p.owner, p.name].every(v => typeof v === 'string' && isValidProfileName(v)) ||
        (p.apiSecret !== undefined && (typeof p.apiSecret !== 'string' || !isValidProfileName(p.apiSecret))) ||
        (p.mock !== undefined && typeof p.mock !== 'boolean') ||
        (p.mock && p.apiSecret !== undefined)) throw new Error('Invalid profile.');
    const pair = p.owner + '/' + p.name;
    if (pairs.has(pair)) throw new Error('Duplicate owner/profile.');
    pairs.add(pair);
  }
  return cfg;
}

export function remoteServer(tls: ServerOptions, profiles: Profile[], readGrants: () => Grant[], backend = runtime) {
  const dashboardAssets = new Map([
    ['/', ['remote.html', 'text/html; charset=utf-8']],
    ['/remote.js', ['remote.js', 'text/javascript; charset=utf-8']],
    ['/app.css', ['app.css', 'text/css; charset=utf-8']],
    ['/icon.svg', ['icon.svg', 'image/svg+xml']],
  ].map(([path, [file, type]]) => [path, { type, body: readFileSync(new URL('../web/' + file, import.meta.url)) }]));
  const wss = new WebSocketServer({ noServer: true, maxPayload: 65536, perMessageDeflate: false });
  const writers = new Map<string, WebSocket>();
  const starting = new Set<Profile>();
  const writerKey = (p: Profile, id: string) => [p.owner, p.name, id].join('/');
  function authorize(req: IncomingMessage) {
    const token = /^Bearer ([\w-]{43})$/.exec(req.headers.authorization ?? '');
    if (!token || req.headers.origin !== undefined) return;
    try {
      const hash = digest(token[1]);
      const grants = readGrants().filter(g => g.digest === hash);
      if (grants.length === 1 && Array.isArray(grants[0].profiles)) return grants[0];
    } catch { /* Fail closed during a bad configuration update. */ }
  }
  function allowed(grant: Grant) {
    return profiles.filter(p => p.owner === grant.owner && grant.profiles.includes(p.name));
  }
  function route(req: IncomingMessage, grant: Grant) {
    const match = /^\/v1\/profiles\/([a-z0-9_-]+)\/sessions(?:\/([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}))?$/.exec(req.url ?? '');
    return { profile: allowed(grant).find(p => p.name === match?.[1]), id: match?.[2] };
  }
  const server = createServer(tls, async (req, res) => {
    const asset = req.method === 'GET' ? dashboardAssets.get(req.url ?? '') : undefined;
    if (asset) {
      res.writeHead(200, {
        'Content-Type': asset.type,
        'Cache-Control': 'no-store',
        'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
        'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'no-referrer',
      });
      return res.end(asset.body);
    }
    function reply(status: number, body: unknown = {}) {
      res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(body));
    }
    const grant = authorize(req);
    if (!grant) return reply(401);
    if (req.method === 'GET' && req.url === '/v1/profiles') return reply(200, allowed(grant).map(p => p.name));
    if (req.method === 'GET' && req.url === '/v1/dashboard') {
      try {
        return reply(200, await Promise.all(allowed(grant).map(async p => ({
          name: p.name,
          mode: p.mock ? 'mock' : p.apiSecret ? 'api' : 'subscription',
          sessions: await backend.list(p),
        }))));
      } catch { return reply(503); }
    }
    const { profile, id } = route(req, grant);
    if (!profile) return reply(404);
    try {
      if (!id && req.method === 'GET') return reply(200, await backend.list(profile));
      if (!id && req.method === 'POST') {
        if (starting.has(profile)) return reply(409);
        starting.add(profile);
        try {
          if ((await backend.list(profile)).length >= 8) return reply(429);
          const created = randomUUID();
          await backend.start(profile, created);
          return reply(201, { id: created });
        } finally {
          starting.delete(profile);
        }
      }
      if (id && req.method === 'DELETE') {
        await backend.end(profile, id);
        writers.get(writerKey(profile, id))?.terminate();
        return reply(200);
      }
      reply(404);
    } catch { reply(503); }
  });
  server.on('upgrade', async (req, socket, head) => {
    socket.on('error', () => socket.destroy());
    const reject = (code: number) => socket.end('HTTP/1.1 ' + code + ' Rejected\r\nConnection: close\r\n\r\n');
    const grant = authorize(req);
    if (!grant) return void reject(401);
    const { profile, id } = route(req, grant);
    if (!profile || !id) return void reject(404);
    try {
      if (!(await backend.list(profile)).includes(id)) return void reject(404);
      const slot = writerKey(profile, id);
      if (writers.has(slot)) return void reject(409);
      if (socket.destroyed) return;
      wss.handleUpgrade(req, socket, head, ws => {
        const child = backend.attach(profile, id);
        writers.set(slot, ws);
        child.stderr.resume(); // Worker diagnostics and terminal contents must never enter gateway logs.
        child.stdin.on('error', () => ws.terminate());
        child.on('error', () => ws.terminate());
        child.on('close', code => ws.close(code === 0 ? 1000 : 1011));
        child.stdout.on('data', (bytes: Buffer) => {
          child.stdout.pause();
          if (ws.readyState === WebSocket.OPEN) ws.send(bytes, err => err ? ws.terminate() : child.stdout.resume());
        });
        let alive = true;
        ws.on('pong', () => { alive = true; });
        const check = setInterval(() => {
          const current = authorize(req);
          if (!alive || !current || !allowed(current).includes(profile)) return ws.terminate();
          alive = false;
          ws.ping();
        }, 5000);
        ws.on('message', (raw, binary) => {
          let bytes = Buffer.from(raw as Buffer);
          if (!binary) {
            try {
              const { cols, rows } = JSON.parse(bytes.toString());
              if (![cols, rows].every(n => Number.isInteger(n) && n >= 1 && n <= 4096)) throw new Error();
              bytes = Buffer.alloc(4);
              bytes.writeUInt16BE(cols);
              bytes.writeUInt16BE(rows, 2);
            } catch { return ws.close(1008); }
          }
          if (child.stdin.writableLength > 262144) return ws.terminate();
          const header = Buffer.alloc(5);
          header[0] = binary ? 0 : 1;
          header.writeUInt32BE(bytes.length, 1);
          if (!child.stdin.write(Buffer.concat([header, bytes]))) {
            ws.pause();
            child.stdin.once('drain', () => ws.resume());
          }
        });
        ws.on('error', () => ws.terminate());
        ws.once('close', () => {
          clearInterval(check);
          writers.delete(slot);
          child.stdout.removeAllListeners('data');
          child.stdout.resume();
          child.stdin.end();
          // EOF makes the in-container PTY helper detach from tmux.
        });
      });
    } catch { if (!socket.destroyed) socket.destroy(); }
  });
  return server;
}

export async function serverCommand(args: string[]) {
  const [verb, path, owner, name] = args;
  const aliases = new Map([['up', 'serve'], ['in', 'login'], ['key', 'keygen']]);
  const action = aliases.get(verb) ?? verb;
  if (action === 'keygen' && args.length === 2) {
    const key = randomBytes(32).toString('base64url');
    writeFileSync(args[1], key + '\n', { mode: 0o600, flag: 'wx' });
    console.log(digest(key));
    return;
  }
  if (!path || !['serve', 'login'].includes(action)) throw new Error('Usage: mc s up CONFIG | in CONFIG OWNER PROFILE | key NEW_KEY_FILE');
  const cfg = loadConfig(path);
  await requireRootless();
  if (action === 'login') {
    const p = cfg.profiles.find(p => p.owner === owner && p.name === name);
    if (!p || p.apiSecret || p.mock) throw new Error('Choose a configured subscription profile.');
    return provision(p);
  }
  const readGrants = (): Grant[] => {
    try { return JSON.parse(readFileSync(cfg.grants, 'utf8')); }
    catch { throw new Error('Cannot read key grants.'); }
  };
  if (!Array.isArray(readGrants())) throw new Error('Expected an array of key grants.');
  const server = remoteServer({ cert: readFileSync(cfg.cert), key: readFileSync(cfg.key), minVersion: 'TLSv1.2' }, cfg.profiles, readGrants);
  server.listen(cfg.port, cfg.host ?? '127.0.0.1', () => console.log('Remote HTTPS server listening.'));
}
