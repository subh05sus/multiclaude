import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.MC_HOME = mkdtempSync(join(tmpdir(), 'mc-pick-'));
const { defaultConfig } = await import('../src/config.ts');
const { pickAccount, reorder } = await import('../src/pick.ts');
const { parseUsageResponse, mergeUsage, usageFromHeaders, peakPct } = await import('../src/usage.ts');

const now = Date.now();
const u = (five: number, week = 0) => ({ source: 'api' as const, at: now, fiveHour: { pct: five, resetsAt: now + 3600_000 }, sevenDay: { pct: week, resetsAt: now + 86400_000 } });

function cfgWith(names: string[]) {
  const c = defaultConfig();
  c.profiles = names.map((name) => ({ name }));
  return c;
}

test('priority: first account in order under its switch-at level', () => {
  const c = cfgWith(['work', 'personal', 'side']);
  const r = pickAccount(c, [
    { name: 'work', loggedIn: true, usage: u(95) },
    { name: 'personal', loggedIn: true, usage: u(40) },
    { name: 'side', loggedIn: true, usage: u(5) },
  ]);
  assert.equal(r.name, 'personal');
  assert.match(r.reason, /skipped work: at 95%/);
});

test('weekly usage counts too, and per-account switch-at wins', () => {
  const c = cfgWith(['work', 'personal']);
  c.profiles[0].switchAt = 99;
  const r = pickAccount(c, [
    { name: 'work', loggedIn: true, usage: u(10, 97) },
    { name: 'personal', loggedIn: true, usage: u(10, 92) },
  ]);
  assert.equal(r.name, 'work');
});

test('most-room picks the lowest peak; paused and signed-out are skipped', () => {
  const c = cfgWith(['a', 'b', 'c', 'd']);
  c.pick = 'most-room';
  c.profiles[2].paused = true;
  const r = pickAccount(c, [
    { name: 'a', loggedIn: true, usage: u(50) },
    { name: 'b', loggedIn: true, usage: u(30) },
    { name: 'c', loggedIn: true, usage: u(1) },
    { name: 'd', loggedIn: false },
  ]);
  assert.equal(r.name, 'b');
});

test('nothing with room returns null with a reason; exclude skips the current account', () => {
  const c = cfgWith(['a', 'b']);
  assert.equal(pickAccount(c, [{ name: 'a', loggedIn: true, usage: u(99) }, { name: 'b', loggedIn: true, usage: u(91) }]).name, null);
  assert.equal(pickAccount(c, [{ name: 'a', loggedIn: true, usage: u(1) }, { name: 'b', loggedIn: true, usage: u(1) }], ['a']).name, 'b');
});

test('reorder keeps unknown names out and leftovers at the end', () => {
  const c = cfgWith(['main', 'a', 'b']);
  reorder(c, ['b', 'zzz', 'main']);
  assert.deepEqual(c.profiles.map((p) => p.name), ['b', 'main', 'a']);
});

test('parses the usage endpoint, including per-model windows', () => {
  const r = parseUsageResponse({
    five_hour: { utilization: 45, resets_at: '2026-10-30T18:00:00Z' },
    seven_day: { utilization: 6.5, resets_at: '2026-11-06T14:30:00Z' },
    seven_day_opus: { utilization: 12, resets_at: null },
    seven_day_oauth_apps: null,
    extra_usage: { is_enabled: false },
  });
  assert.equal(r.fiveHour?.pct, 45);
  assert.equal(r.fiveHour?.resetsAt, Date.parse('2026-10-30T18:00:00Z'));
  assert.equal(r.models?.opus.pct, 12);
  assert.equal(r.extra?.enabled, false);
});

test('merge: freshest wins, passed resets go to zero, errors only when nothing is good', () => {
  const old = { source: 'api' as const, at: now - 1000, fiveHour: { pct: 80, resetsAt: now + 1000 } };
  const fresh = { source: 'statusline' as const, at: now, fiveHour: { pct: 82, resetsAt: now + 1000 } };
  assert.equal(mergeUsage([old, fresh]).fiveHour?.pct, 82);
  const reset = { source: 'api' as const, at: now, fiveHour: { pct: 99, resetsAt: now - 1 } };
  assert.equal(mergeUsage([reset]).fiveHour?.pct, 0);
  assert.equal(mergeUsage([{ source: 'api', at: now, error: 'token-expired' }]).error, 'token-expired');
  assert.equal(mergeUsage([]).error, 'no-data');
});

test('headers: fractions become percent; a rejected status means limited', () => {
  const h = usageFromHeaders({ 'anthropic-ratelimit-unified-5h-utilization': '0.91', 'anthropic-ratelimit-unified-status': 'rejected' });
  assert.equal(Math.round(h!.fiveHour!.pct), 91);
  assert.equal(h!.limited, true);
  assert.equal(peakPct(h!), 100);
  assert.equal(usageFromHeaders({}), null);
});
