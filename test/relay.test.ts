// The relay against a fake Anthropic: pass-through, plan-limit fallback to the API key,
// staying on the key until reset, the daily cap, and fallback switched off.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server, type IncomingHttpHeaders } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';

const home = mkdtempSync(join(tmpdir(), 'mc-relay-'));
process.env.MC_HOME = home;
process.env.MC_API_KEY = 'sk-ant-test-key-0000000000000000000000';

let upstream: Server;
let relayServer: Server;
let relayPort = 0;
const seen: { headers: IncomingHttpHeaders; path: string }[] = [];
let planLimited = false;
let cfg: import('../src/config.ts').Config;
const usageEvents: unknown[] = [];

const SSE = [
  'event: message_start',
  'data: {"type":"message_start","message":{"model":"claude-opus-5-5","usage":{"input_tokens":1000,"output_tokens":1,"cache_read_input_tokens":0,"cache_creation_input_tokens":0}}}',
  '',
  'event: content_block_delta',
  'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"hi"}}',
  '',
  'event: message_delta',
  'data: {"type":"message_delta","usage":{"output_tokens":500}}',
  '',
  'event: message_stop',
  'data: {"type":"message_stop"}',
  '',
  '',
].join('\n');

before(async () => {
  upstream = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      seen.push({ headers: req.headers, path: req.url ?? '' });
      const viaKey = Boolean(req.headers['x-api-key']);
      if (!viaKey && planLimited) {
        res.writeHead(429, {
          'content-type': 'application/json',
          'anthropic-ratelimit-unified-status': 'rejected',
          'anthropic-ratelimit-unified-reset': String(Math.floor(Date.now() / 1000) + 3600),
        });
        return res.end('{"type":"error","error":{"type":"rate_limit_error","message":"limit"}}');
      }
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'anthropic-ratelimit-unified-status': 'allowed',
        'anthropic-ratelimit-unified-5h-utilization': '0.42',
        'anthropic-ratelimit-unified-5h-reset': String(Math.floor(Date.now() / 1000) + 3600),
      });
      res.end(SSE);
    });
  });
  await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', () => r()));
  process.env.MC_UPSTREAM = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;

  const { defaultConfig } = await import('../src/config.ts');
  const { handleRelay } = await import('../src/relay.ts');
  cfg = defaultConfig();
  cfg.fallback.enabled = true;
  cfg.fallback.dailyCapUsd = 5;
  relayServer = createServer((req, res) => {
    const m = /^\/relay\/([\w-]+)(\/.*)$/.exec(req.url ?? '');
    if (!m) return res.end();
    void handleRelay(req, res, m[1], m[2], { config: () => cfg, onUsage: (_p, u) => usageEvents.push(u), onFallbackChange: () => {} });
  });
  await new Promise<void>((r) => relayServer.listen(0, '127.0.0.1', () => r()));
  relayPort = (relayServer.address() as AddressInfo).port;
});

after(() => {
  upstream.close();
  relayServer.close();
});

async function ask(profile = 'main') {
  const r = await fetch(`http://127.0.0.1:${relayPort}/relay/${profile}/v1/messages?beta=true`, {
    method: 'POST',
    headers: { authorization: 'Bearer sk-ant-oat-fake', 'anthropic-beta': 'oauth-2025-04-20,claude-code-20250219', 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'claude-opus-5-5', max_tokens: 10, messages: [{ role: 'user', content: 'hi' }] }),
  });
  return { status: r.status, text: await r.text() };
}

test('passes requests through on the login and reads usage headers', async () => {
  seen.length = 0;
  const r = await ask();
  assert.equal(r.status, 200);
  assert.match(r.text, /message_stop/);
  assert.equal(seen[0].headers.authorization, 'Bearer sk-ant-oat-fake');
  assert.equal(seen[0].headers['x-api-key'], undefined);
  assert.equal(seen[0].path, '/v1/messages?beta=true');
  const u = usageEvents.at(-1) as { fiveHour?: { pct: number } };
  assert.equal(Math.round(u.fiveHour!.pct), 42);
});

test('on a plan limit, resends the same request on the API key and meters it', async () => {
  const { readSpend } = await import('../src/spend.ts');
  const { fallbackState } = await import('../src/relay.ts');
  planLimited = true;
  seen.length = 0;
  const r = await ask();
  assert.equal(r.status, 200, 'the client sees a normal reply');
  assert.equal(seen.length, 2, 'login try, then the key');
  const keyReq = seen[1].headers;
  assert.equal(keyReq['x-api-key'], process.env.MC_API_KEY);
  assert.equal(keyReq.authorization, undefined, 'no login token sent with the key');
  assert.equal(keyReq['anthropic-beta'], 'claude-code-20250219', 'oauth beta removed');
  assert.ok(fallbackState('main').active);
  const day = Object.values(readSpend().days)[0];
  // 1000 input * $4/M + 500 output * $20/M = $0.014
  assert.ok(Math.abs(day.total - 0.014) < 1e-9, `spend ${day.total}`);
});

test('stays on the key until the plan resets', async () => {
  seen.length = 0;
  const r = await ask();
  assert.equal(r.status, 200);
  assert.equal(seen.length, 1);
  assert.ok(seen[0].headers['x-api-key']);
});

test('past the daily cap, the plan limit reaches Claude Code unchanged', async () => {
  const { clearFallback } = await import('../src/relay.ts');
  clearFallback('main');
  cfg.fallback.dailyCapUsd = 0.01;
  seen.length = 0;
  const r = await ask();
  assert.equal(r.status, 429);
  assert.equal(seen.length, 1, 'never tried the key');
  cfg.fallback.dailyCapUsd = 5;
});

test('with the fallback off, nothing touches the key', async () => {
  cfg.fallback.enabled = false;
  seen.length = 0;
  const r = await ask('work');
  assert.equal(r.status, 429);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].headers['x-api-key'], undefined);
  cfg.fallback.enabled = true;
});

test('a profile outside the allowed list keeps the plan limit', async () => {
  cfg.fallback.profiles = ['main'];
  seen.length = 0;
  const r = await ask('side');
  assert.equal(r.status, 429);
  assert.equal(seen.length, 1);
  cfg.fallback.profiles = [];
  planLimited = false;
});
