import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = mkdtempSync(join(tmpdir(), 'mc-shell-'));
process.env.HOME = home;
process.env.USERPROFILE = home;
process.env.SHELL = '/bin/zsh';
process.env.MC_HOME = join(home, '.multiclaude');
const psProfile = join(home, 'Documents', 'PowerShell', 'profile.ps1');
mkdirSync(join(home, 'Documents', 'PowerShell'), { recursive: true });
process.env.MC_PS_PROFILES = psProfile;
writeFileSync(join(home, '.zshrc'), 'export PATH="$HOME/bin:$PATH"\nalias ll="ls -la"\n');

const { routeClaude, installShell, uninstallShell, shellStatus } = await import('../src/shell.ts');

test('chats pick an account; management commands and special setups run plain', () => {
  assert.equal(routeClaude([], {}).kind, 'pick');
  assert.equal(routeClaude(['-p', 'hi'], {}).kind, 'pick');
  assert.equal(routeClaude(['--resume', 'abc'], {}).kind, 'pick');
  assert.equal(routeClaude(['fix the bug'], {}).kind, 'pick');
  for (const a of [['mcp', 'add', 'x'], ['update'], ['--version'], ['auth', 'login'], ['doctor']]) {
    assert.equal(routeClaude(a, {}).kind, 'plain', a.join(' '));
  }
  assert.equal(routeClaude([], { MC_PROFILE: 'work' }).kind, 'plain', 'nested call stays on its account');
  assert.equal(routeClaude([], { CLAUDE_CONFIG_DIR: '/x' }).kind, 'plain');
  assert.equal(routeClaude([], { ANTHROPIC_API_KEY: 'k' }).kind, 'plain');
  assert.equal(routeClaude([], { MC_BYPASS: '1' }).kind, 'plain');
});

test('mc shell on adds one marked block, is idempotent, and off restores the file', { skip: process.platform === 'win32' && 'zsh files are not used on Windows' }, () => {
  const rc = join(home, '.zshrc');
  const original = readFileSync(rc, 'utf8');
  installShell();
  installShell();
  const on = readFileSync(rc, 'utf8');
  assert.equal(on.split('>>> multiclaude').length - 1, 1, 'one block only');
  assert.match(on, /claude\(\) \{ ".*\/bin\/mc" claude "\$@"; \}/);
  assert.ok(on.startsWith(original.trimEnd()), 'existing lines untouched');
  assert.ok(existsSync(`${rc}.mc-backup`));
  assert.deepEqual(shellStatus().installed, [rc, psProfile]);
  uninstallShell();
  assert.equal(readFileSync(rc, 'utf8').trim(), original.trim());
  assert.deepEqual(shellStatus().installed, []);
});

test('PowerShell gets a claude function in its profile, removed cleanly', () => {
  writeFileSync(psProfile, 'Set-Alias ll Get-ChildItem\r\n', { flag: 'w' });
  installShell();
  const on = readFileSync(psProfile, 'utf8');
  assert.match(on, /function claude \{ & ".*" claude @args \}/);
  assert.match(on, /Set-Alias ll Get-ChildItem/);
  uninstallShell();
  const off = readFileSync(psProfile, 'utf8');
  assert.ok(!off.includes('multiclaude'));
  assert.match(off, /Set-Alias ll Get-ChildItem/);
});
