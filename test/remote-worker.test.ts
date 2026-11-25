import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { containerArgs } from '../src/remote-runtime.ts';

test('worker volumes are specific to owner and profile and API billing is explicit', () => {
  const args = (owner: string, name: string, apiSecret?: string) => containerArgs({ owner, name, apiSecret });
  const a = args('alice', 'main');
  const volume = (v: string[]) => v[v.indexOf('--volume') + 1];
  assert.notEqual(volume(a), volume(args('bob', 'main')));
  assert.notEqual(volume(a), volume(args('alice', 'other')));
  assert.equal(a.includes('--secret'), false);
  assert.equal(a.includes('--network=none'), false);
  const mock = containerArgs({ owner: 'alice', name: 'work', mock: true });
  assert.ok(mock.includes('--network=none'));
  assert.equal(mock.includes('--secret'), false);
  assert.equal(a.some(x => x.includes('ANTHROPIC') || x.includes('relay')), false);
  assert.ok(args('alice', 'api', 'alice-console').includes('alice-console,type=env,target=ANTHROPIC_API_KEY'));
  assert.throws(() => args('../alice', 'main'));
});

test('Linux worker reconnects to the same real tmux terminal', {
  skip: process.platform !== 'linux' || spawnSync('tmux', ['-V']).status !== 0,
}, () => {
  const result = spawnSync('python3', ['-I', 'test/remote-worker.py'], { encoding: 'utf8', timeout: 35000 });
  assert.equal(result.status, 0, result.error?.message ?? result.stderr);
});
