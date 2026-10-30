import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = mkdtempSync(join(tmpdir(), 'mc-export-'));
mkdirSync(join(root, 'dot-claude'));
writeFileSync(join(root, 'claude.json'), '{}');
process.env.MC_HOME = join(root, 'mc');
process.env.MC_MAIN_CLAUDE_DIR = join(root, 'dot-claude');
process.env.MC_MAIN_CLAUDE_JSON = join(root, 'claude.json');

const { updateConfig, loadConfig } = await import('../src/config.ts');
const { exportBundle, importBundle } = await import('../src/exporter.ts');

test('export is encrypted and imports back with the right passphrase only', async () => {
  updateConfig((c) => {
    c.profiles.push({ name: 'work', label: 'Team Max', switchAt: 85 });
    c.pick = 'most-room';
  });
  const file = join(root, 'backup.mcx');
  await exportBundle(file, 'correct horse battery', false);
  const bytes = readFileSync(file);
  assert.equal(bytes.subarray(0, 4).toString(), 'MCX1');
  assert.ok(!bytes.toString('latin1').includes('Team Max'), 'contents are not readable');

  await assert.rejects(importBundle(file, 'wrong passphrase', false), /Wrong passphrase/);

  updateConfig((c) => {
    c.profiles = c.profiles.filter((p) => p.name === 'main');
    c.pick = 'priority';
  });
  const notes = await importBundle(file, 'correct horse battery', false);
  const cfg = loadConfig();
  assert.deepEqual(cfg.profiles.map((p) => p.name), ['main', 'work']);
  assert.equal(cfg.profiles[1].switchAt, 85);
  assert.equal(cfg.pick, 'most-room');
  assert.ok(notes.some((n) => n.startsWith('work: set up')));
});
