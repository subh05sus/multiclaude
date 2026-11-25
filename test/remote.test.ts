import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { ChildProcess, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { EventEmitter, once } from 'node:events';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:https';
import { createServer, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';
import { digest, remoteServer } from '../src/remote-server.ts';
import type { Profile } from '../src/remote-runtime.ts';

// A self-signed fixture for 127.0.0.1, explicitly trusted by the test clients.
const cert = readFileSync(new URL('./remote-test-cert.pem', import.meta.url));
const key = readFileSync(new URL('./remote-test-key.pem', import.meta.url));
const alice = randomBytes(32).toString('base64url');
const bob = randomBytes(32).toString('base64url');
const profiles = '/v1/profiles';
const sessions = (profile = 'main') => `${profiles}/${profile}/sessions`;

function fakeAttachment() {
  return Object.assign(new ChildProcess(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
  });
}

async function listen(t: TestContext) {
  const grants = [
    { owner: 'alice', digest: digest(alice), profiles: ['main', 'side'] },
    { owner: 'bob', digest: digest(bob), profiles: ['main', 'work'] },
  ];
  const active = new Map<string, Set<string>>();
  const attachments: ReturnType<typeof fakeAttachment>[] = [];
  function running(p: Profile) {
    const scope = `${p.owner}/${p.name}`;
    if (!active.has(scope)) active.set(scope, new Set());
    return active.get(scope)!;
  }
  const backend = {
    async list(p: Profile) { return [...running(p)]; },
    async start(p: Profile, id: string) { running(p).add(id); },
    async end(p: Profile, id: string) { running(p).delete(id); },
    attach() {
      const child = fakeAttachment();
      attachments.push(child);
      return child as ChildProcessWithoutNullStreams;
    },
  };
  const server = remoteServer({ cert, key }, [
    { owner: 'alice', name: 'main' }, { owner: 'alice', name: 'side', mock: true },
    { owner: 'alice', name: 'private' },
    { owner: 'bob', name: 'main' }, { owner: 'bob', name: 'work', apiSecret: 'bob-secret' },
  ], () => grants, backend);
  const sockets = new Set<WebSocket>();
  t.after(async () => {
    for (const socket of sockets) socket.terminate();
    await new Promise<void>((resolve, reject) =>
      server.close(error => error ? reject(error) : resolve()));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address() as AddressInfo;

  async function ask(path: string, token = alice, method = 'GET', origin?: string) {
    const headers = {
      ...(token ? { Authorization: 'Bearer ' + token } : {}),
      ...(origin ? { Origin: origin } : {}),
    };
    const req = request({ hostname: '127.0.0.1', port, path, ca: cert, method, headers, agent: false });
    req.end();
    const [res] = await once(req, 'response');
    const chunks: Buffer[] = [];
    for await (const chunk of res) chunks.push(chunk);
    const contentType = res.headers['content-type'];
    const body = Buffer.concat(chunks).toString();
    return { status: res.statusCode, headers: res.headers, body: contentType === 'application/json' ? JSON.parse(body) : body };
  }

  function socket(path: string, token = alice, origin?: string) {
    const ws = new WebSocket(`wss://127.0.0.1:${port}${path}`, {
      ca: cert, origin, headers: token ? { Authorization: 'Bearer ' + token } : {},
    });
    sockets.add(ws);
    ws.on('error', () => {});
    ws.once('close', () => sockets.delete(ws));
    return ws;
  }

  async function create(profile = 'main', token = alice) {
    const session = await ask(sessions(profile), token, 'POST');
    assert.equal(session.status, 201);
    assert.match(session.body.id, /^[0-9a-f-]{36}$/);
    return { id: session.body.id as string, path: `${sessions(profile)}/${session.body.id}` };
  }

  return { ask, socket, create, grants, attachments, backend };
}

test('remote dashboard serves a public shell and keeps profile data behind the bearer grant', async t => {
  const { ask, create } = await listen(t);
  const page = await ask('/', '');
  assert.equal(page.status, 200);
  assert.match(page.headers['content-type'] ?? '', /^text\/html/);
  assert.match(page.headers['content-security-policy'] ?? '', /frame-ancestors 'none'/);
  assert.match(page.body, /Remote dashboard/);
  assert.match(page.body, /href="\/app.css"/);
  assert.match(page.body, /src="\/remote.js"/);
  const script = await ask('/remote.js', '');
  assert.equal(script.status, 200);
  assert.match(script.headers['content-type'] ?? '', /^text\/javascript/);
  assert.match((await ask('/app.css', '')).headers['content-type'] ?? '', /^text\/css/);
  assert.equal((await ask('/v1/dashboard', '')).status, 401);
  assert.equal((await ask('/v1/dashboard', alice, 'GET', 'https://example.test')).status, 401);
  const { id } = await create();
  assert.deepEqual((await ask('/v1/dashboard')).body, [
    { name: 'main', mode: 'subscription', sessions: [id] },
    { name: 'side', mode: 'mock', sessions: [] },
  ]);
  assert.deepEqual((await ask('/v1/dashboard', bob)).body, [
    { name: 'main', mode: 'subscription', sessions: [] },
    { name: 'work', mode: 'api', sessions: [] },
  ]);
});

test('remote TLS endpoints require a unique bearer grant and reject browser origins', { timeout: 10000 }, async t => {
  const { ask, socket, create, grants } = await listen(t);
  const { path } = await create();
  const origin = 'https://example.test';
  for (const token of ['', 'short', 'x'.repeat(43)]) {
    assert.equal((await ask(profiles, token)).status, 401);
    await assert.rejects(once(socket(path, token), 'open'), /response: 401/);
  }
  assert.equal((await ask(profiles, alice, 'GET', origin)).status, 401);
  await assert.rejects(once(socket(path, alice, origin), 'open'), /response: 401/);
  assert.deepEqual((await ask(profiles)).body, ['main', 'side']);
  assert.deepEqual((await ask(profiles, bob)).body, ['main', 'work']);
  grants.push(grants[0]);
  assert.equal((await ask(profiles)).status, 401);
});

test('remote attachments and termination are scoped to owner and profile', { timeout: 10000 }, async t => {
  const { ask, socket, create, attachments } = await listen(t);
  const { id, path } = await create();
  const bobSession = await create('main', bob);
  assert.deepEqual((await ask(sessions())).body, [id]);
  assert.deepEqual((await ask(sessions(), bob)).body, [bobSession.id]);
  assert.equal((await ask(sessions('private'))).status, 404);
  assert.equal((await ask(sessions('side'), bob, 'POST')).status, 404);

  const first = socket(path);
  await once(first, 'open');
  const worker = attachments[0];
  assert.equal((await ask(path, bob, 'DELETE')).status, 200);
  const sidePath = `${sessions('side')}/${id}`;
  assert.equal((await ask(sidePath, alice, 'DELETE')).status, 200);
  assert.equal((await ask(sidePath, bob, 'DELETE')).status, 404);
  assert.deepEqual((await ask(sessions())).body, [id]);
  await assert.rejects(once(socket(path, bob), 'open'), /response: 404/);
  await assert.rejects(once(socket(sidePath), 'open'), /response: 404/);
  await assert.rejects(once(socket(path), 'open'), /response: 409/);
  assert.equal(attachments.length, 1);

  const input = once(worker.stdin, 'data');
  first.send(Buffer.from([0x00, 0xff]));
  assert.deepEqual((await input)[0], Buffer.from([0, 0, 0, 0, 2, 0x00, 0xff]));
  const resize = once(worker.stdin, 'data');
  first.send(JSON.stringify({ cols: 80, rows: 24 }));
  assert.deepEqual((await resize)[0], Buffer.from([1, 0, 0, 0, 4, 0, 80, 0, 24]));
  const output = once(first, 'message');
  worker.stdout.write(Buffer.from([0x1b, 0xff]));
  assert.deepEqual(await output, [Buffer.from([0x1b, 0xff]), true]);

  const detached = once(worker.stdin, 'finish');
  const closed = once(first, 'close');
  first.close();
  await Promise.all([closed, detached]);
  assert.deepEqual((await ask(sessions())).body, [id]);
  const second = socket(path);
  await once(second, 'open');
  assert.equal(attachments.length, 2);
  const ended = once(second, 'close');
  assert.equal((await ask(path, alice, 'DELETE')).status, 200);
  await ended;
  assert.deepEqual((await ask(sessions())).body, []);
  assert.deepEqual((await ask(sessions(), bob)).body, [bobSession.id]);
  await assert.rejects(once(socket(path), 'open'), /response: 404/);
});

test('revoking a grant closes an attached writer and blocks fresh requests', { timeout: 12000 }, async t => {
  const { ask, socket, create, grants, attachments } = await listen(t);
  const { id, path } = await create();
  const writer = socket(path);
  await once(writer, 'open');
  const closed = once(writer, 'close');
  const detached = once(attachments[0].stdin, 'finish');
  const [revoked] = grants.splice(0, 1);
  assert.equal((await ask(sessions())).status, 401);
  await assert.rejects(once(socket(path), 'open'), /response: 401/);
  await Promise.all([closed, detached]);
  grants.push(revoked);
  assert.deepEqual((await ask(sessions())).body, [id]);
});

test('the remote gateway bounds terminal payloads and resize requests', { timeout: 10000 }, async t => {
  const { socket, create, attachments } = await listen(t);
  const { path } = await create();
  const first = socket(path);
  await once(first, 'open');
  const invalidResize = once(first, 'close');
  const detached = once(attachments[0].stdin, 'finish');
  first.send(JSON.stringify({ cols: 4097, rows: 24 }));
  assert.equal((await invalidResize)[0], 1008);
  await detached;
  const second = socket(path);
  await once(second, 'open');
  const oversized = once(second, 'close');
  const worker = attachments[1];
  const disconnected = once(worker.stdin, 'finish');
  const input: Buffer[] = [];
  worker.stdin.on('data', chunk => input.push(chunk));
  second.send(Buffer.alloc(65537));
  await Promise.all([oversized, disconnected]);
  assert.deepEqual(input, []);
});

test('the remote gateway enforces the session limit across concurrent creates', { timeout: 10000 }, async t => {
  const { ask, create, backend } = await listen(t);
  const { path } = await create();
  for (let i = 1; i < 7; i++) await create();
  const gate = new EventEmitter();
  const start = backend.start;
  const paused = once(gate, 'paused');
  const release = once(gate, 'release');
  const mock = t.mock.method(backend, 'start', async (profile: Profile, id: string) => {
    gate.emit('paused');
    await release;
    await start(profile, id);
  });
  const pending = create();
  await paused;
  try {
    assert.equal((await ask(sessions(), alice, 'POST')).status, 409);
  } finally {
    gate.emit('release');
    await pending;
    mock.mock.restore();
  }
  assert.equal((await ask(sessions(), alice, 'POST')).status, 429);
  await create('main', bob);
  await create('side');
  assert.equal((await ask(path, alice, 'DELETE')).status, 200);
  await create();
  assert.equal((await ask(sessions())).body.length, 8);
});

test('the local daemon serves its existing dashboard API without remote routes', { timeout: 10000 }, async t => {
  const home = mkdtempSync(join(tmpdir(), 'mc-remote-test-'));
  const reservation = createServer().listen(0, '127.0.0.1');
  await once(reservation, 'listening');
  const { port } = reservation.address() as AddressInfo;
  await new Promise<void>(resolve => reservation.close(() => resolve()));
  writeFileSync(join(home, 'config.json'), JSON.stringify({ port }));
  const child = spawn(process.execPath, [fileURLToPath(new URL('../src/cli.ts', import.meta.url)), 'daemon'], {
    env: {
      ...process.env, MC_HOME: home,
      MC_MAIN_CLAUDE_DIR: join(home, 'claude'), MC_MAIN_CLAUDE_JSON: join(home, 'claude.json'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const exit = once(child, 'exit');
  t.after(async () => {
    child.kill();
    await exit;
    rmSync(home, { recursive: true, force: true });
  });
  const listening = (async () => {
    for await (const chunk of child.stdout) {
      if (String(chunk).includes(`listening on http://127.0.0.1:${port}`)) return;
    }
    assert.fail('local daemon exited before listening');
  })();
  await listening;
  const base = `http://127.0.0.1:${port}`;
  const ping = await fetch(base + '/api/ping');
  assert.equal(ping.status, 200);
  assert.equal((await ping.json()).ok, true);
  assert.equal((await fetch(base + profiles)).status, 404);
});
