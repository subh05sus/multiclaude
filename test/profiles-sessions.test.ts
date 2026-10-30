// Shared links between profiles and ~/.claude (in temp folders), their self-repair,
// the .claude.json sync, and the stats and handover readers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, lstatSync, rmSync, existsSync, utimesSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = mkdtempSync(join(tmpdir(), 'mc-prof-'));
const main = join(root, 'dot-claude');
mkdirSync(join(main, 'projects'), { recursive: true });
mkdirSync(join(main, 'skills', 'demo'), { recursive: true });
writeFileSync(join(main, 'settings.json'), '{"theme":"dark"}');
writeFileSync(join(main, 'CLAUDE.md'), '# rules\n');
writeFileSync(join(root, 'claude.json'), JSON.stringify({
  hasCompletedOnboarding: true,
  oauthAccount: { emailAddress: 'me@example.com', accountUuid: 'acct-main' },
  pluginPanes: { asked: [{ plugin: 'progress-board', id: 'progress' }] },
  userID: 'secret-user-id',
  mcpServers: { github: { command: 'gh-mcp' } },
  projects: { '/p': { hasTrustDialogAccepted: true, allowedTools: [] } },
}));
process.env.MC_HOME = join(root, 'mc');
process.env.MC_MAIN_CLAUDE_DIR = main;
process.env.MC_MAIN_CLAUDE_JSON = join(root, 'claude.json');

const P = await import('../src/profiles.ts');

test('a new profile links shared files and seeds its own .claude.json', () => {
  P.createProfileDir('work');
  const dir = P.profileDir('work');
  mkdirSync(join(main, 'dev-mods', 'x', 'progress-board'), { recursive: true });
  mkdirSync(join(main, 'local-marketplace', 'plugins'), { recursive: true });
  P.ensureLinks('work');
  for (const e of ['projects', 'settings.json', 'CLAUDE.md', 'skills', 'history.jsonl', 'todos', 'tasks', 'plugins', 'dev-mods', 'local-marketplace', 'paste-cache']) {
    assert.ok(lstatSync(join(dir, e)).isSymbolicLink(), `${e} is a link`);
  }
  const j = JSON.parse(readFileSync(join(dir, '.claude.json'), 'utf8'));
  assert.equal(j.hasCompletedOnboarding, true);
  assert.deepEqual(j.mcpServers, { github: { command: 'gh-mcp' } });
  assert.equal(j.projects['/p'].hasTrustDialogAccepted, true);
  assert.equal(j.oauthAccount, undefined, 'never copies the other account');
  assert.deepEqual(j.pluginPanes, { asked: [{ plugin: 'progress-board', id: 'progress' }] }, 'mod panels carry over');
  assert.ok(existsSync(join(dir, 'dev-mods', 'x', 'progress-board')), 'mods reachable through the link');
  assert.equal(j.userID, undefined);
  assert.equal(P.configDirEnv('work'), dir);
  assert.equal(P.configDirEnv('main'), null);
});

test('a link replaced by a newer real file is merged back and re-linked', () => {
  const dir = P.profileDir('work');
  rmSync(join(dir, 'settings.json'));
  writeFileSync(join(dir, 'settings.json'), '{"theme":"light"}');
  const future = new Date(Date.now() + 5000);
  utimesSync(join(dir, 'settings.json'), future, future);
  const fixed = P.ensureLinks('work');
  assert.deepEqual(fixed, ['settings.json']);
  assert.ok(lstatSync(join(dir, 'settings.json')).isSymbolicLink());
  assert.equal(readFileSync(join(main, 'settings.json'), 'utf8'), '{"theme":"light"}');
});

test('profile detection from the environment', () => {
  assert.equal(P.profileFromEnv({ MC_PROFILE: 'x' }), 'x');
  assert.equal(P.profileFromEnv({ CLAUDE_CONFIG_DIR: P.profileDir('work') }), 'work');
  assert.equal(P.profileFromEnv({}), 'main');
});

test('removing a profile keeps everything shared', () => {
  P.removeProfileDir('work');
  assert.ok(!existsSync(P.profileDir('work')));
  assert.ok(existsSync(join(main, 'skills', 'demo')));
  assert.equal(readFileSync(join(main, 'CLAUDE.md'), 'utf8'), '# rules\n');
  assert.throws(() => P.removeProfileDir('main'));
});

test('stats read new lines only, count each message once, and split by account', async () => {
  const S = await import('../src/sessions.ts');
  const proj = join(main, 'projects', '-p');
  mkdirSync(proj, { recursive: true });
  const id = '11111111-2222-3333-4444-555555555555';
  const file = join(proj, `${id}.jsonl`);
  const ts = new Date().toISOString();
  const asst = (msgId: string, out: number) => JSON.stringify({ type: 'assistant', timestamp: ts, cwd: '/p', sessionId: id, message: { id: msgId, model: 'claude-sonnet-5-5', usage: { input_tokens: 1_000_000, output_tokens: out } } });
  writeFileSync(file, [JSON.stringify({ type: 'user', cwd: '/p', timestamp: ts, message: { content: 'Build the thing' } }), asst('m1', 0), asst('m1', 0), ''].join('\n'));
  S.recordSessionStart({ at: new Date(Date.now() - 60_000).toISOString(), sessionId: id, profile: 'work' });

  let r = await S.statsReport(7);
  assert.equal(r.totals.msgs, 1, 'duplicate content-block lines count once');
  assert.ok(Math.abs(r.totals.cost - 2) < 1e-9, `$2 for 1M Sonnet 5.5 input, got ${r.totals.cost}`);
  assert.equal(r.byProfile[0].key, 'work');

  appendFileSync(file, asst('m2', 100_000) + '\n');
  r = await S.statsReport(7);
  assert.equal(r.totals.msgs, 2);
  assert.ok(Math.abs(r.totals.cost - 5) < 1e-9, `+$2 input +$1 output, got ${r.totals.cost}`);

  const list = S.listSessions(10);
  assert.equal(list[0].id, id);
  assert.equal(list[0].profile, 'work');
  assert.equal(list[0].title, 'Build the thing');
});

test('handover note includes the goal, files and todos', async () => {
  const H = await import('../src/handover.ts');
  const proj = join(main, 'projects', '-p');
  const id = '99999999-2222-3333-4444-555555555555';
  const lines = [
    { type: 'user', cwd: '/p', gitBranch: 'feat', message: { content: 'Add dark mode to settings' } },
    { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Edit', input: { file_path: '/p/settings.tsx' } }, { type: 'tool_use', name: 'TodoWrite', input: { todos: [{ content: 'Wire toggle', status: 'completed' }, { content: 'Add tests', status: 'pending' }] } }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', content: 'ok' }] } },
    { type: 'user', message: { content: 'also persist it' } },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'Saved to localStorage.' }] } },
  ];
  writeFileSync(join(proj, `${id}.jsonl`), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  const md = H.handoverMarkdown(H.buildHandover(id), 'work', 'personal');
  assert.match(md, /Add dark mode to settings/);
  assert.match(md, /also persist it/);
  assert.match(md, /\/p\/settings\.tsx/);
  assert.match(md, /- \[x\] Wire toggle/);
  assert.match(md, /- \[ \] Add tests/);
  assert.match(md, /branch `feat`/);
  assert.match(md, /Saved to localStorage/);
});
