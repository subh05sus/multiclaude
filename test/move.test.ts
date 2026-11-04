import { test } from 'node:test';
import assert from 'node:assert/strict';
import { moveTarget, profileOf } from '../plugin/hooks/target.ts';

const state = (peak: number, pick: string | null = 'claude-max') => ({
  pick: { name: pick },
  profiles: [{ name: 'main', peak, switchAt: 90 }, { name: 'claude-max', peak: 0, switchAt: 90 }],
});

test('the button shows once this account is past its switch-at level and another has room', () => {
  assert.equal(moveTarget(state(100), 'main'), 'claude-max');
  assert.equal(moveTarget(state(90), 'main'), 'claude-max');
  assert.equal(moveTarget(state(89), 'main'), null);
});

test('the button stays away when there is nowhere to go', () => {
  assert.equal(moveTarget(state(100, null), 'main'), null);
  assert.equal(moveTarget(state(100, 'main'), 'main'), null);
  assert.equal(moveTarget(state(100), 'unknown'), null);
  assert.equal(moveTarget(null, 'main'), null);
});

test('the session account comes from MC_PROFILE, then the profile folder', () => {
  assert.equal(profileOf('work', undefined, '/h/.multiclaude'), 'work');
  assert.equal(profileOf(undefined, '/h/.multiclaude/profiles/claude-max', '/h/.multiclaude'), 'claude-max');
  assert.equal(profileOf(undefined, '/h/.claude', '/h/.multiclaude'), 'main');
  assert.equal(profileOf(undefined, undefined, '/h/.multiclaude'), 'main');
});
