import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer as createHttpServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
const cert = fileURLToPath(new URL('./remote-test-cert.pem', import.meta.url));
const key = fileURLToPath(new URL('./remote-test-key.pem', import.meta.url));
const collection = '/v1/profiles/main/sessions';
const first = 'abcd1234-0000-4000-8000-000000000001';
const second = 'abcd5678-0000-4000-8000-000000000002';
const created = 'efab0000-0000-4000-8000-000000000003';

function fixture(t: TestContext) {
  const home = mkdtempSync(join(tmpdir(), 'mc-shortcuts-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const env = {
    ...process.env,
    MC_HOME: home,
    MC_MAIN_CLAUDE_DIR: join(home, 'claude'),
    MC_MAIN_CLAUDE_JSON: join(home, 'claude.json'),
    MC_ACCESS_KEY_FILE: join(home, 'access'),
    MC_SERVER_URL: '',
    NODE_EXTRA_CA_CERTS: cert,
  };
  const run = (...args: string[]) =>
    exec(process.execPath, [cli, ...args], { cwd: home, env, timeout: 5000 });
  return { home, env, run };
}

async function listen(t: TestContext, server: ReturnType<typeof createHttpServer> | ReturnType<typeof createHttpsServer>) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise<void>((resolve, reject) =>
    server.close(error => error ? reject(error) : resolve())));
  return (server.address() as AddressInfo).port;
}

test('remote shortcuts keep the full commands and only end unambiguous sessions', { timeout: 15000 }, async t => {
  const { env, run } = fixture(t);
  const token = randomBytes(32).toString('base64url');
  writeFileSync(env.MC_ACCESS_KEY_FILE, token + '\n');
  const active = new Set<string>();
  const calls: string[] = [];
  const server = createHttpsServer({ cert: readFileSync(cert), key: readFileSync(key) }, (req, res) => {
    const call = `${req.method} ${req.url}`;
    calls.push(call);
    const reply = (status: number, body: unknown) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (req.headers.authorization !== 'Bearer ' + token) return reply(401, {});
    if (call === 'GET /v1/profiles') return reply(200, ['main']);
    if (call === 'GET ' + collection) return reply(200, [...active]);
    if (call === 'POST ' + collection) {
      active.add(created);
      return reply(201, { id: created });
    }
    if (call.startsWith('DELETE ' + collection + '/')) {
      active.delete(call.slice(('DELETE ' + collection + '/').length));
      return reply(200, {});
    }
    return reply(404, {});
  });
  env.MC_SERVER_URL = `https://127.0.0.1:${await listen(t, server)}`;

  assert.equal((await run('r', 'ls')).stdout.trim(), 'main');
  assert.equal((await run('remote', 'profiles')).stdout.trim(), 'main');
  assert.equal((await run('r', 'new', 'main')).stdout.trim(), created);
  assert.equal((await run('r', 'ps', 'main')).stdout.trim(), created);
  await assert.rejects(run('r', 'a', 'main'), { code: 1, message: /requires an interactive terminal/ });
  assert.equal((await run('r', 'rm', 'main')).stdout.trim(), 'Remote session ended.');
  await assert.rejects(run('r', 'rm', 'main'), { code: 1, message: /No active session matches/ });
  active.add(first);
  active.add(second);
  await assert.rejects(run('r', 'rm', 'main'), { code: 1, message: /Multiple active sessions match/ });
  await assert.rejects(run('r', 'rm', 'main', 'abcd'), { code: 1, message: /Multiple active sessions match/ });
  await assert.rejects(run('r', 'rm', 'main', 'beef'), { code: 1, message: /No active session matches/ });
  assert.deepEqual(calls.filter(call => call.startsWith('DELETE')), [`DELETE ${collection}/${created}`]);
  await run('r', 'rm', 'main', 'ABCD1');
  await run('remote', 'end', 'main', second);
  assert.deepEqual(calls.slice(-3), [
    `GET ${collection}`, `DELETE ${collection}/${first}`, `DELETE ${collection}/${second}`,
  ]);
  assert.deepEqual([...active], []);
});

test('local r and s profiles keep precedence and --s key forces the server shortcut', { timeout: 10000 }, async t => {
  const { home, env, run } = fixture(t);
  const server = createHttpServer((req, res) => {
    res.writeHead(req.url === '/api/ping' ? 200 : 404).end();
  });
  const port = await listen(t, server);
  writeFileSync(join(home, 'config.json'), JSON.stringify({
    profiles: [{ name: 'main' }, { name: 'r' }, { name: 's' }], port, claudePath: process.execPath,
  }));
  mkdirSync(env.MC_MAIN_CLAUDE_DIR);
  for (const command of ['ls', 'key']) writeFileSync(join(home, command), 'console.log(process.env.MC_PROFILE)');

  const path = join(home, 'new-key');
  assert.equal((await run('r', 'ls')).stdout.trim(), 'r');
  assert.equal((await run('s', 'key', path)).stdout.trim(), 's');
  assert.equal(existsSync(path), false);

  const { stdout } = await run('--s', 'key', path);
  const token = readFileSync(path, 'utf8').trim();
  assert.match(token, /^[\w-]{43}$/);
  assert.equal(stdout.trim(), createHash('sha256').update(token).digest('hex'));
  await assert.rejects(run('--s', 'key', path), { code: 1, message: /EEXIST/ });
  assert.equal(readFileSync(path, 'utf8').trim(), token);
});
