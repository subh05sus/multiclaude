import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const home = mkdtempSync(join(tmpdir(), 'mc-resume-'));
process.env.MC_HOME = home;
const { defaultConfig } = await import('../src/config.ts');
const { planWait, lifted, waitForReset } = await import('../src/autoresume.ts');

const T0 = 1_800_000_000_000;
const H = 3600_000;
const usage = (five: number, week: number, fiveReset = T0 + 2 * H, weekReset = T0 + 50 * H) => ({
  source: 'api' as const, at: T0, fiveHour: { pct: five, resetsAt: fiveReset }, sevenDay: { pct: week, resetsAt: weekReset },
});

test('plan: waits for the reset of the full window, the later one when both are full', () => {
  assert.deepEqual(planWait(usage(100, 40), T0), { kind: 'reset', at: T0 + 2 * H, windows: ['5-hour'] });
  assert.deepEqual(planWait(usage(100, 100), T0), { kind: 'reset', at: T0 + 50 * H, windows: ['5-hour', 'weekly'] });
  assert.deepEqual(planWait(usage(30, 20), T0), { kind: 'short' }, 'not full: a short rate limit');
  assert.deepEqual(planWait({ source: 'api', at: T0, error: 'fetch-failed' }, T0), { kind: 'unknown' });
  assert.deepEqual(planWait({ source: 'relay', at: T0, limited: true, fiveHour: { pct: 60, resetsAt: T0 + H } }, T0), { kind: 'reset', at: T0 + H, windows: ['plan'] });
  assert.equal(lifted(usage(0, 40)), true);
  assert.equal(lifted(usage(100, 40)), false);
  assert.equal(lifted({ source: 'relay', at: T0, limited: true }), false);
});

function harness(readings: (now: number) => ReturnType<typeof usage>, opts: { aliveUntil?: number; enabledUntil?: number } = {}) {
  let now = T0;
  const notes: string[] = [];
  const logs: string[] = [];
  let checks = 0;
  const deps = {
    usage: async () => {
      checks++;
      return readings(now);
    },
    sleep: async (ms: number) => {
      now += ms;
    },
    now: () => now,
    sessionAlive: () => now < (opts.aliveUntil ?? Infinity),
    enabled: () => now < (opts.enabledUntil ?? Infinity),
    notify: (_t: string, b: string) => notes.push(b),
    log: ((_k: string, text: string) => logs.push(text)) as never,
    nextWithRoom: () => 'claude-max',
  };
  return { deps, notes, logs, get now() { return now; }, get checks() { return checks; } };
}

test('waits for its own account to reset, confirms, then resumes', async () => {
  const cfg = defaultConfig();
  const h = harness((now) => (now >= T0 + 2 * H ? usage(0, 41) : usage(100, 40)));
  const r = await waitForReset('main', cfg, h.deps);
  assert.deepEqual(r, { resume: true, reason: 'the limit reset' });
  assert.ok(h.now >= T0 + 2 * H, 'not before the reset');
  assert.ok(h.now < T0 + 2 * H + 6 * 60_000, 'soon after the reset');
  assert.match(h.notes[0], /main is out until .*continue by itself.*Move to claude-max/);
  assert.ok(h.checks <= 3, 'does not hammer the usage endpoint while waiting');
});

test('keeps waiting when the reset lands late', async () => {
  const cfg = defaultConfig();
  const h = harness((now) => (now >= T0 + 2 * H + 12 * 60_000 ? usage(0, 41) : usage(100, 40)));
  const r = await waitForReset('main', cfg, h.deps);
  assert.equal(r.resume, true);
  assert.ok(h.now >= T0 + 2 * H + 12 * 60_000);
});

test('stops quietly when the session closes or auto-resume is turned off', async () => {
  const cfg = defaultConfig();
  const closed = harness(() => usage(100, 40), { aliveUntil: T0 + H });
  assert.deepEqual(await waitForReset('main', cfg, closed.deps), { resume: false, reason: 'the session was closed' });
  const off = harness(() => usage(100, 40), { enabledUntil: T0 + H });
  assert.deepEqual(await waitForReset('main', cfg, off.deps), { resume: false, reason: 'auto-resume was turned off' });
});

test('a short rate limit retries after a minute; gives up after maxWaitHours', async () => {
  const cfg = defaultConfig();
  const short = harness(() => usage(20, 10));
  assert.deepEqual(await waitForReset('main', cfg, short.deps), { resume: true, reason: 'a short rate limit' });
  assert.equal(short.now, T0 + 60_000);
  cfg.autoResume.maxWaitHours = 3;
  const stuck = harness(() => usage(100, 40, T0 + 100 * H));
  const r = await waitForReset('main', cfg, stuck.deps);
  assert.equal(r.resume, false);
  assert.match(r.reason, /3 hours/);
});

test('the hook ignores other stop reasons and respects the off switch', () => {
  const cli = join(import.meta.dirname, '..', 'src', 'cli.ts');
  const run = (input: object, env: Record<string, string> = {}) =>
    spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', cli, 'hook', 'limit-wait'], { input: JSON.stringify(input), env: { ...process.env, MC_NO_NOTIFY: '1', ...env }, timeout: 10_000 });
  assert.equal(run({ session_id: 's1', error: 'server_error' }).status, 0);
  const offHome = join(home, 'off');
  mkdirSync(offHome, { recursive: true });
  writeFileSync(join(offHome, 'autoresume-off'), '');
  const t = Date.now();
  const r = run({ session_id: 's1', error: 'rate_limit' }, { MC_HOME: offHome });
  assert.equal(r.status, 0, 'off switch: exits without waking the session');
  assert.ok(Date.now() - t < 5000, 'and right away');
});
