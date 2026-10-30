import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.MC_HOME = mkdtempSync(join(tmpdir(), 'mc-alerts-'));
const { defaultConfig } = await import('../src/config.ts');
const { checkAlerts, wouldAlert } = await import('../src/alerts.ts');

const cfg = defaultConfig();
const reset = Date.now() + 3 * 3600_000;
const reading = (pct: number, resetsAt = reset) => ({ source: 'api' as const, at: Date.now(), fiveHour: { pct, resetsAt } });
const activity = () => readFileSync(join(process.env.MC_HOME!, 'activity.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));

test('the test runner never sends real notifications', () => {
  assert.ok(process.env.NODE_TEST_CONTEXT, 'node --test sets NODE_TEST_CONTEXT, which notify() checks');
});

test('announces each level once per window, tolerating small reset-time differences', () => {
  assert.equal(wouldAlert(cfg, 'main', reading(50)), false);
  assert.equal(wouldAlert(cfg, 'main', reading(82)), true);
  checkAlerts(cfg, 'main', reading(82), () => 'work');
  assert.equal(activity().length, 1);
  assert.match(activity()[0].text, /82% of the 5-hour limit; next with room: work/);
  // Same window, reset time off by a second (status line vs API): not new.
  assert.equal(wouldAlert(cfg, 'main', reading(85, reset + 1000)), false);
  checkAlerts(cfg, 'main', reading(85, reset + 1000), () => 'work');
  assert.equal(activity().length, 1);
  // The next level is new.
  checkAlerts(cfg, 'main', reading(96), () => null);
  assert.equal(activity().length, 2);
});

test('a reset is announced once when usage drops back', () => {
  checkAlerts(cfg, 'main', reading(3, Date.now() + 5 * 3600_000), () => null);
  const kinds = activity().map((a) => a.kind);
  assert.equal(kinds.filter((k) => k === 'reset').length, 0, 'not before the recorded reset time');
  checkAlerts(cfg, 'main', { source: 'api', at: Date.now(), fiveHour: { pct: 2 } }, () => null);
});
