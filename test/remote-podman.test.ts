import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import test from 'node:test';
import { containerArgs, requireRootless, runtime } from '../src/remote-runtime.ts';

const run = promisify(execFile);

// Requires the disposable worker image prepared by the Linux CI job.
test('Podman isolates profiles, reattaches the live terminal and removes ended containers', {
  skip: process.env.MC_TEST_PODMAN !== '1', timeout: 90000,
}, async t => {
  await requireRootless();
  const id = randomUUID();
  const profiles = ['a', 'b'].map(owner => ({ owner: owner + id.slice(0, 8), name: 'main', mock: true }));
  const containers: string[] = [];
  for (const p of profiles) {
    const args = containerArgs(p);
    const volume = args[args.indexOf('--volume') + 1].split(':')[0];
    t.after(async () => {
      await runtime.end(p, id);
      await run('podman', ['volume', 'rm', '--force', volume]);
    });
    await runtime.start(p, id);
    assert.ok((await runtime.list(p)).includes(id));
    const { stdout } = await run('podman', ['ps', '--filter', 'volume=' + volume, '--format', '{{.ID}}']);
    containers.push(stdout.trim());
  }
  await run('podman', ['exec', containers[0], 'touch', '/home/worker/private-marker']);
  await run('podman', ['exec', containers[1], 'test', '!', '-e', '/home/worker/private-marker']);

  async function attachUntil(marker: string, input?: string) {
    const child = runtime.attach(profiles[0], id);
    const exit = once(child, 'close');
    let output = '';
    child.stdout.on('data', chunk => { output = (output + chunk.toString()).slice(-32768); });
    try {
      if (input) {
        for (let i = 0; i < 200 && !output.includes('ready-for-input'); i++) await delay(50);
        assert.ok(output.includes('ready-for-input'));
        const bytes = Buffer.from(input);
        const header = Buffer.alloc(5);
        header.writeUInt32BE(bytes.length, 1);
        child.stdin.write(Buffer.concat([header, bytes]));
      }
      for (let i = 0; i < 200 && !output.includes(marker) && child.exitCode === null; i++) await delay(50);
      assert.ok(output.includes(marker), 'Expected terminal output after attach');
    } finally {
      child.stdin.end();
      await exit;
    }
  }
  await attachUntil('ready-for-input');
  await attachUntil('reply=persisted', 'persisted\r');
  await attachUntil('reply=persisted');
  await runtime.end(profiles[0], id);
  assert.deepEqual(await runtime.list(profiles[0]), []);
  assert.deepEqual(await runtime.list(profiles[1]), [id]);
});
