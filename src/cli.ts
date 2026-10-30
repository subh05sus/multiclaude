#!/usr/bin/env node
import { spawnSync, execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { loadConfig, saveConfig, updateConfig, type PickMode } from './config.ts';
import { MAIN_PROFILE, MC_DIR } from './paths.ts';
import { isValidProfileName, logActivity, fmtPct } from './util.ts';
import { createProfileDir, profileInfo, isMain, removeProfileDir, configDirEnv, claudeJsonPath, accountUuidMap } from './profiles.ts';
import { launch, ensureDaemon, daemonUp, profileEnv } from './launch.ts';
import { readState, type AppState } from './state.ts';
import { pickAccount, reorder } from './pick.ts';
import { listSessions, findSession } from './sessions.ts';
import { writeHandover, handoverPrompt } from './handover.ts';
import { saveApiKey, readApiKey, deleteApiKey, deleteGenericPassword, claudeKeychainService } from './keychain.ts';
import { readJson } from './util.ts';
import { spawnClaudeSync, claudeExecutable, stopDaemon, onPath, IS_WIN } from './platform.ts';

const RESERVED = new Set([
  'claude', 'shell', 'auto', 'next', 'resume', 'handover', 'add', 'remove', 'list', 'ls', 'status', 'order', 'set', 'pick', 'fallback', 'ui',
  'dashboard', 'daemon', 'start', 'stop', 'statusline', 'hook', 'setup', 'uninstall', 'export', 'import', 'doctor', 'help', 'use', 'sessions', 'refresh',
]);

const HELP = `multiclaude (mc) — several Claude accounts in one Claude Code

  mc                          pick an account in the terminal picker
  mc <name> [claude args]     start Claude Code on that account
  mc auto [claude args]       start on the first account in your order with room
  mc next [--fresh]           move this folder's latest session to the next account with room
  mc shell on|off|status      make plain \`claude\` pick an account like \`mc auto\` (opt-in)
  mc resume <name> [id]       continue a session (default: the latest here) on an account
  mc handover <id> --to <name>  start fresh on an account with a handover note

  mc list                     accounts, usage and priority order
  mc add <name> [--label x]   add an account and sign in
  mc remove <name>            remove an account and its saved login
  mc order <a> <b> ...        set the priority order
  mc set <name> switch-at <n> | pause | unpause | label <text>
  mc pick priority|most-room  how "mc auto" chooses
  mc fallback on|off|cap <usd>|key|status   paid API key when a plan is out
  mc sessions                 recent sessions and which account ran them
  mc ui                       open the dashboard

  mc setup                    status line, session hook, background service, menu bar
  mc uninstall                undo mc setup (profiles and logins stay)
  mc export <file> [--with-logins]   encrypted backup to move to another Mac
  mc import <file> [--overwrite]
  mc doctor                   check everything is wired up
`;

function die(msg: string): never {
  console.error(msg);
  process.exit(1);
}

async function stateNow(): Promise<AppState | null> {
  const cfg = loadConfig();
  await ensureDaemon(cfg);
  try {
    const r = await fetch(`http://127.0.0.1:${cfg.port}/api/state`, { signal: AbortSignal.timeout(5000) });
    if (r.ok) return (await r.json()) as AppState;
  } catch {
    /* fall back to the last saved state */
  }
  return readState();
}

function readHidden(prompt: string): Promise<string> {
  return new Promise((resolve) => {
    process.stderr.write(prompt);
    const stdin = process.stdin;
    if (!stdin.isTTY) {
      let s = '';
      stdin.on('data', (d) => (s += d));
      stdin.on('end', () => resolve(s.trim()));
      return;
    }
    let s = '';
    stdin.setRawMode(true);
    stdin.resume();
    const onData = (d: Buffer) => {
      for (const ch of d.toString('utf8')) {
        if (ch === '\r' || ch === '\n') {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.off('data', onData);
          process.stderr.write('\n');
          return resolve(s);
        }
        if (ch === '\x03') process.exit(130);
        if (ch === '\x7f') s = s.slice(0, -1);
        else s += ch;
      }
    };
    stdin.on('data', onData);
  });
}

function bar(pct?: number, width = 10): string {
  if (pct === undefined) return '░'.repeat(width);
  const f = Math.round((Math.min(100, pct) / 100) * width);
  return '█'.repeat(f) + '░'.repeat(width - f);
}

async function cmdList(): Promise<void> {
  const s = await stateNow();
  if (!s) die('No state yet. Run "mc doctor".');
  console.log(`Pick: ${s.pickMode === 'priority' ? 'first in order with room' : 'most room left'} · switch at ${s.switchAt}% · fallback ${s.fallback.enabled ? `on ($${s.fallback.spentToday.toFixed(2)}/$${s.fallback.dailyCapUsd} today)` : 'off'}\n`);
  for (const p of s.profiles) {
    const who = p.info.loggedIn ? `${p.info.email ?? ''} ${p.info.plan ? `(${p.info.plan})` : ''}` : 'signed out';
    const u = p.usage;
    const flags = [p.paused && 'paused', p.fallback.active && 'on API key', s.pick.name === p.name && '★ pick', p.peak !== undefined && p.peak >= p.switchAt && 'full'].filter(Boolean).join(', ');
    console.log(` ${p.position}. ${p.name.padEnd(12)} ${who}`);
    console.log(`    5h ${bar(u.fiveHour?.pct)} ${fmtPct(u.fiveHour?.pct).padStart(4)}   week ${bar(u.sevenDay?.pct)} ${fmtPct(u.sevenDay?.pct).padStart(4)}   switch at ${p.switchAt}%${flags ? `   [${flags}]` : ''}${u.error && u.error !== 'no-data' ? `   (${u.error})` : ''}`);
  }
  console.log(`\n${s.pick.reason}`);
}

async function cmdAdd(args: string[]): Promise<void> {
  const name = (args[0] ?? '').toLowerCase();
  if (!isValidProfileName(name)) die('Name it with 1-32 lowercase letters, numbers, - or _ (for example "work" or "max2").');
  if (RESERVED.has(name)) die(`"${name}" is a command name; pick another.`);
  const li = args.indexOf('--label');
  const label = li >= 0 ? args[li + 1] : undefined;
  const cfg = loadConfig();
  if (!cfg.profiles.some((p) => p.name === name)) {
    cfg.profiles.push({ name, label });
    saveConfig(cfg);
  }
  createProfileDir(name);
  logActivity('profile-added', 'Profile created', name);
  console.log(`Set up "${name}" (shares history, settings, skills, plugins and memory with your other accounts).`);
  console.log('Now sign in with the Claude account you want here. A browser window will open.\n');
  const env = profileEnv({ ...cfg, fallback: { ...cfg.fallback, enabled: false } }, name);
  const r = spawnClaudeSync(claudeExecutable(cfg.claudePath), ['auth', 'login'], { stdio: 'inherit', env });
  const info = await profileInfo(name);
  if (!info.loggedIn) die(`\nNot signed in yet. Run "mc ${name} auth login" or just "mc ${name}" to try again.`);
  const dup = [...accountUuidMap(cfg.profiles.map((p) => p.name)).entries()].filter(([id, n]) => n !== name && id === info.accountUuid);
  console.log(`\n✓ ${name}: ${info.email ?? 'signed in'}${info.plan ? ` · ${info.plan}` : ''} · position ${cfg.profiles.findIndex((p) => p.name === name) + 1} in your order`);
  if (dup.length) console.log(`  Heads-up: this is the same Claude account as "${dup[0][1]}". Each profile should be a different account.`);
  void r;
}

async function cmdRemove(args: string[]): Promise<void> {
  const name = args[0];
  if (!name) die('Usage: mc remove <name>');
  if (isMain(name)) die('"main" is your normal ~/.claude setup and stays.');
  const cfg = loadConfig();
  if (!cfg.profiles.some((p) => p.name === name)) die(`No profile called "${name}".`);
  const service = claudeKeychainService(configDirEnv(name));
  cfg.profiles = cfg.profiles.filter((p) => p.name !== name);
  if (cfg.defaultProfile === name) cfg.defaultProfile = MAIN_PROFILE;
  saveConfig(cfg);
  removeProfileDir(name);
  await deleteGenericPassword(service);
  logActivity('profile-removed', 'Profile removed and signed out', name);
  console.log(`Removed "${name}". Shared history and settings are untouched.`);
}

async function cmdAuto(args: string[]): Promise<void> {
  const s = await stateNow();
  const cfg = loadConfig();
  const name = s?.pick.name;
  if (!name) {
    console.error(`${s?.pick.reason ?? 'No usage data yet.'} Starting on your default, ${cfg.defaultProfile}.`);
    return launch(cfg.defaultProfile, args);
  }
  return launch(name, args, { reason: s!.pick.reason });
}

function latestHere(): ReturnType<typeof listSessions>[number] | undefined {
  const cfg = loadConfig();
  const cwd = process.cwd();
  return listSessions(300, accountUuidMap(cfg.profiles.map((p) => p.name))).find((x) => x.cwd === cwd);
}

async function cmdNext(args: string[]): Promise<void> {
  const fresh = args.includes('--fresh');
  const rest = args.filter((a) => a !== '--fresh');
  const sess = latestHere();
  const s = await stateNow();
  const cfg = loadConfig();
  const from = sess?.profile ?? process.env.MC_PROFILE ?? cfg.defaultProfile;
  const pick = pickAccount(cfg, (s?.profiles ?? []).map((p) => ({ name: p.name, loggedIn: p.info.loggedIn, usage: p.usage })), [from]);
  if (!pick.name) die(`No other account has room. ${pick.reason}${cfg.fallback.enabled ? '' : ' Turn on the API fallback with "mc fallback on" to keep going.'}`);
  if (!sess) {
    console.error(`No session found in this folder, so starting a new one on ${pick.name}.`);
    return launch(pick.name, rest, { reason: pick.reason });
  }
  logActivity('switch', `Moved "${sess.title.slice(0, 60)}" from ${from} to ${pick.name}${fresh ? ' with a handover note' : ''}`, pick.name);
  console.error(`Moving "${sess.title.slice(0, 70)}" from ${from} to ${pick.name}. Close the old window first if it's still open.`);
  if (fresh) {
    const { path } = writeHandover(sess.id, from, pick.name);
    return launch(pick.name, [...rest, handoverPrompt(path)], { reason: `fresh session with handover note ${path}` });
  }
  return launch(pick.name, ['--resume', sess.id, ...rest], { reason: 'same conversation, new account' });
}

async function cmdResume(args: string[]): Promise<void> {
  const [name, id, ...rest] = args;
  if (!name) die('Usage: mc resume <name> [session-id]');
  if (id && !id.startsWith('-')) {
    if (!findSession(id)) die(`No session ${id}. "mc sessions" lists them.`);
    logActivity('switch', `Resumed session ${id.slice(0, 8)}`, name);
    return launch(name, ['--resume', id, ...rest]);
  }
  return launch(name, ['--continue', ...(id ? [id, ...rest] : rest)]);
}

async function cmdHandover(args: string[]): Promise<void> {
  const id = args[0];
  const ti = args.indexOf('--to');
  const to = ti >= 0 ? args[ti + 1] : undefined;
  if (!id || !to) die('Usage: mc handover <session-id> --to <name>');
  const sess = listSessions(300).find((s) => s.id === id);
  const { path } = writeHandover(id, sess?.profile ?? '?', to);
  console.error(`Handover note: ${path}`);
  if (sess?.cwd && existsSync(sess.cwd)) process.chdir(sess.cwd);
  return launch(to, [handoverPrompt(path)], { reason: 'fresh session from a handover note' });
}

function cmdOrder(args: string[]): void {
  if (!args.length) die('Usage: mc order <first> <second> ...');
  const cfg = loadConfig();
  const unknown = args.filter((a) => !cfg.profiles.some((p) => p.name === a));
  if (unknown.length) die(`Unknown: ${unknown.join(', ')}`);
  reorder(cfg, args);
  saveConfig(cfg);
  logActivity('settings', `Priority order: ${cfg.profiles.map((p) => p.name).join(' → ')}`);
  console.log(`Order: ${cfg.profiles.map((p, i) => `${i + 1}. ${p.name}`).join('  ')}`);
}

function cmdSet(args: string[]): void {
  const [name, what, ...val] = args;
  const cfg = loadConfig();
  const p = cfg.profiles.find((x) => x.name === name);
  if (!p) die('Usage: mc set <name> switch-at <n> | pause | unpause | label <text>');
  if (what === 'switch-at') {
    const n = Number(val[0]);
    if (val[0] === 'default') delete p.switchAt;
    else if (!(n >= 10 && n <= 100)) die('switch-at takes a number from 10 to 100, or "default".');
    else p.switchAt = Math.round(n);
  } else if (what === 'pause') p.paused = true;
  else if (what === 'unpause') delete p.paused;
  else if (what === 'label') p.label = val.join(' ') || undefined;
  else die('Usage: mc set <name> switch-at <n> | pause | unpause | label <text>');
  saveConfig(cfg);
  console.log(`${name}: ${what} ${val.join(' ')}`.trim());
}

async function cmdFallback(args: string[]): Promise<void> {
  const [what, val] = args;
  if (what === 'on' || what === 'off') {
    updateConfig((c) => (c.fallback.enabled = what === 'on'));
    logActivity('settings', `API fallback turned ${what}`);
    const hasKey = Boolean(await readApiKey());
    console.log(`API fallback ${what}.${what === 'on' && !hasKey ? ' No key saved yet: run "mc fallback key".' : ''}`);
    if (what === 'on') console.log('New sessions route through the local relay; sessions already open keep going direct until restarted.');
  } else if (what === 'cap') {
    const n = Number(val);
    if (!(n >= 0)) die('Usage: mc fallback cap <dollars per day>');
    updateConfig((c) => (c.fallback.dailyCapUsd = n));
    console.log(`Daily cap: $${n}`);
  } else if (what === 'key') {
    const key = (await readHidden('Paste your Anthropic API key (sk-ant-…): ')).trim();
    if (!key) {
      await deleteApiKey();
      return console.log('Key removed.');
    }
    if (!/^sk-ant-[\w-]{20,}$/.test(key)) die('That does not look like an Anthropic API key.');
    if (!(await saveApiKey(key))) die('Could not save to the Keychain.');
    logActivity('settings', 'API key saved to the Keychain');
    console.log(process.platform === 'darwin' ? 'Saved to the Keychain (item "multiclaude-api-key").' : 'Saved to ~/.multiclaude/api-key (readable only by you).');
  } else {
    const cfg = loadConfig();
    const s = readState();
    console.log(`Fallback: ${cfg.fallback.enabled ? 'on' : 'off'} · cap $${cfg.fallback.dailyCapUsd}/day · spent today $${(s?.fallback.spentToday ?? 0).toFixed(2)} · key ${(await readApiKey()) ? 'saved' : 'missing'}`);
  }
}

async function cmdSessions(): Promise<void> {
  const cfg = loadConfig();
  for (const s of listSessions(25, accountUuidMap(cfg.profiles.map((p) => p.name)))) {
    const when = new Date(s.updatedAt).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
    console.log(`${s.id.slice(0, 8)}  ${when.padEnd(16)} ${s.profile.padEnd(10)} ${(s.cwd ?? s.project).replace(process.env.HOME ?? '~', '~').slice(-34).padEnd(34)}  ${s.title.slice(0, 60)}`);
  }
}

/** `claude …` through the shell function: pick an account, or run plain Claude Code for management commands. */
async function cmdClaude(args: string[]): Promise<void> {
  const { routeClaude } = await import('./shell.ts');
  const route = routeClaude(args);
  if (route.kind === 'pick') return cmdAuto(args);
  const cfg = loadConfig();
  const r = spawnClaudeSync(claudeExecutable(cfg.claudePath), args, { stdio: 'inherit' });
  process.exit(r.status ?? (r.error ? 127 : 1));
}

async function cmdShell(args: string[]): Promise<void> {
  const { installShell, uninstallShell, shellStatus } = await import('./shell.ts');
  const what = args[0] ?? 'status';
  if (what === 'on') {
    const files = installShell();
    const st = shellStatus();
    console.log(files.length ? `Added the \`claude\` function to ${files.join(', ')}.` : `Already on (${st.installed.join(', ')}).`);
    console.log(IS_WIN ? 'Open a new PowerShell or Git Bash window and type claude as usual: it starts on the account mc auto would pick. (In cmd.exe, use mc auto.)' : 'Open a new terminal tab (or run "exec $SHELL") and type claude as usual: it starts on the account mc auto would pick.');
    const { psPolicyNote } = await import('./shell.ts');
    const note = psPolicyNote();
    if (note) console.log(note);
    console.log('Management commands (claude mcp, claude update, claude --version, ...) still run plain. "command claude" skips multiclaude.');
  } else if (what === 'off') {
    const files = uninstallShell();
    console.log(files.length ? `Removed from ${files.join(', ')}. Open a new tab for plain claude.` : 'It was not on.');
  } else {
    const st = shellStatus();
    console.log(st.installed.length ? `On: \`claude\` picks an account (${st.installed.join(', ')}).` : 'Off: \`claude\` is plain Claude Code on main. Turn it on with "mc shell on".');
  }
}

async function cmdSetup(args: string[]): Promise<void> {
  const { installClaudeSettings, installBinLink, installAutostart, installMenubar } = await import('./setup.ts');
  const linkNote = installBinLink();
  console.log(linkNote ? `• ${linkNote}` : `• mc is on your PATH (~/.local/bin/${IS_WIN ? 'mc.cmd' : 'mc'})`);
  for (const c of installClaudeSettings()) console.log(`• Added to ~/.claude/settings.json: ${c} (backup saved next to it)`);
  if (IS_WIN || process.platform !== 'darwin') {
    const { stopDaemon } = await import('./platform.ts');
    stopDaemon();
  }
  console.log(`• ${installAutostart()}`);
  if (!args.includes('--no-menubar') && process.platform === 'darwin') {
    const err = installMenubar();
    console.log(err ? `• Menu bar app did not build:\n${err}` : '• Menu bar app installed and opens at login');
  }
  if (args.includes('--shell')) {
    const { installShell } = await import('./shell.ts');
    const files = installShell();
    console.log(files.length ? `• \`claude\` now picks an account (${files.join(', ')}). Open a new tab to use it.` : '• `claude` already picks an account');
  } else if (!args.includes('--no-shell')) {
    console.log('• Tip: run "mc shell on" so plain `claude` picks an account the way "mc auto" does');
  }
  const up = await ensureDaemon();
  console.log(up ? `\nDashboard: http://127.0.0.1:${loadConfig().port}` : '\nThe service has not answered yet; check ~/.multiclaude/daemon.log.');
  console.log('Add another account with: mc add <name>');
}

async function cmdUninstall(): Promise<void> {
  const { removeClaudeSettings, uninstallAgents } = await import('./setup.ts');
  const { uninstallShell } = await import('./shell.ts');
  for (const c of removeClaudeSettings()) console.log(`• Removed ${c} from settings.json`);
  for (const f of uninstallShell()) console.log(`• Removed the \`claude\` function from ${f}`);
  uninstallAgents();
  const { stopDaemon } = await import('./platform.ts');
  stopDaemon();
  console.log(process.platform === 'darwin' ? '• Background service and menu bar app stopped' : '• Background service stopped and removed from login');
  console.log(`Profiles and logins are still in ${MC_DIR} and the Keychain. Remove accounts with "mc remove <name>".`);
}

async function cmdDoctor(): Promise<void> {
  const cfg = loadConfig();
  const ok = (b: boolean, msg: string, fix = '') => console.log(`${b ? '✓' : '✗'} ${msg}${!b && fix ? `\n    → ${fix}` : ''}`);
  const [major, minor] = process.versions.node.split('.').map(Number);
  ok(major > 23 || (major === 23 && minor >= 6) || (major === 22 && minor >= 18), `Node ${process.versions.node}`, 'multiclaude needs Node 22.18+ or 23.6+ (they run TypeScript directly)');
  const found = cfg.claudePath || onPath('claude');
  ok(Boolean(found), `claude found at ${found ?? '?'}`, 'install Claude Code or set claudePath in ~/.multiclaude/config.json');
  ok(await daemonUp(cfg.port), `background service on port ${cfg.port}`, 'run "mc setup" (or "mc daemon" to see errors)');
  const { MAIN_CLAUDE_DIR } = await import('./paths.ts');
  const settings = readJson<{ statusLine?: { command?: string }; hooks?: { SessionStart?: { hooks?: { command?: string }[] }[] } }>(`${MAIN_CLAUDE_DIR}/settings.json`, {});
  ok(Boolean(settings.statusLine?.command?.includes(' statusline')), 'status line installed', 'run "mc setup"');
  ok(Boolean(settings.hooks?.SessionStart?.some((g) => g.hooks?.some((h) => h.command?.includes('hook session-start')))), 'session hook installed', 'run "mc setup"');
  for (const p of cfg.profiles) {
    const i = await profileInfo(p.name);
    ok(i.loggedIn, `${p.name}: ${i.loggedIn ? `${i.email ?? 'signed in'} ${i.plan ? `(${i.plan})` : ''}` : 'signed out'}`, `mc ${p.name} auth login`);
    if (!isMain(p.name)) ok(existsSync(claudeJsonPath(p.name)), `${p.name}: profile folder`, `mc add ${p.name}`);
  }
  if (cfg.fallback.enabled) ok(Boolean(await readApiKey()), 'API key for the fallback', 'mc fallback key');
  const { shellStatus } = await import('./shell.ts');
  const sh = shellStatus();
  console.log(`${sh.installed.length ? '✓' : '·'} plain \`claude\` ${sh.installed.length ? 'picks an account' : 'runs main (optional: mc shell on)'}`);
  if (process.env.ANTHROPIC_API_KEY) console.log('! ANTHROPIC_API_KEY is set in this shell: Claude Code will bill it instead of your plans.');
}

async function main(): Promise<void> {
  const [cmd, ...args] = process.argv.slice(2);
  switch (cmd) {
    case undefined:
      if (process.stdin.isTTY && process.stdout.isTTY) return (await import('./tui.ts')).pickerTui([]);
      return cmdAuto([]);
    case 'help': case '--help': case '-h': return void console.log(HELP);
    case 'auto': return cmdAuto(args);
    case 'claude': return cmdClaude(args);
    case 'shell': return cmdShell(args);
    case 'next': return cmdNext(args);
    case 'resume': return cmdResume(args);
    case 'handover': return cmdHandover(args);
    case 'list': case 'ls': case 'status': return cmdList();
    case 'add': return cmdAdd(args);
    case 'remove': return cmdRemove(args);
    case 'order': return cmdOrder(args);
    case 'set': return cmdSet(args);
    case 'use': {
      if (!loadConfig().profiles.some((p) => p.name === args[0])) die('Usage: mc use <name>   (the account used when nothing has room)');
      updateConfig((c) => (c.defaultProfile = args[0]));
      return void console.log(`Default: ${args[0]}`);
    }
    case 'pick': {
      const m = args[0] as PickMode;
      if (m !== 'priority' && m !== 'most-room') die('Usage: mc pick priority|most-room');
      updateConfig((c) => (c.pick = m));
      return void console.log(`mc auto now picks: ${m === 'priority' ? 'the first account in your order with room' : 'the account with the most room left'}`);
    }
    case 'fallback': return cmdFallback(args);
    case 'sessions': return cmdSessions();
    case 'refresh': {
      const s = await stateNow();
      if (s) await fetch(`http://127.0.0.1:${s.port}/api/refresh`, { method: 'POST', headers: { 'x-mc-token': (await import('./util.ts')).getSecret() } }).catch(() => {});
      return cmdList();
    }
    case 'ui': case 'dashboard': {
      await ensureDaemon();
      execFile('open', [`http://127.0.0.1:${loadConfig().port}/`]);
      return;
    }
    case 'daemon': return (await import('./daemon.ts')).runDaemon();
    case 'start': return void console.log((await ensureDaemon()) ? 'Running.' : 'Did not start; see ~/.multiclaude/daemon.log');
    case 'stop': {
      const stopped = stopDaemon();
      if (!stopped && !IS_WIN) spawnSync('pkill', ['-f', 'src/cli.ts daemon']);
      return void console.log(process.platform === 'darwin' ? 'Stopped (the LaunchAgent restarts it unless you run "mc uninstall").' : 'Stopped.');
    }
    case 'statusline': return (await import('./statusline.ts')).statusline();
    case 'hook':
      if (args[0] === 'session-start') return (await import('./statusline.ts')).sessionStartHook();
      return;
    case 'setup': return cmdSetup(args);
    case 'uninstall': return cmdUninstall();
    case 'export': {
      if (!args[0]) die('Usage: mc export <file> [--with-logins]');
      const pass = await readHidden('Passphrase: ');
      if (pass.length < 8) die('Use a passphrase of at least 8 characters.');
      if ((await readHidden('Again: ')) !== pass) die('The passphrases did not match.');
      const { exportBundle } = await import('./exporter.ts');
      const r = await exportBundle(args[0], pass, args.includes('--with-logins'));
      console.log(`Saved ${r.profiles} profiles${r.logins ? ` and ${r.logins} logins` : ''} to ${args[0]}.`);
      if (r.logins) console.log('Logins refresh themselves; use each account on one Mac at a time, or sign in again on the old one.');
      return;
    }
    case 'import': {
      if (!args[0]) die('Usage: mc import <file> [--overwrite]');
      const { importBundle } = await import('./exporter.ts');
      try {
        for (const n of await importBundle(args[0], await readHidden('Passphrase: '), args.includes('--overwrite'))) console.log(`• ${n}`);
      } catch (e) {
        die((e as Error).message);
      }
      return;
    }
    case 'doctor': return cmdDoctor();
    default: {
      const cfg = loadConfig();
      if (cfg.profiles.some((p) => p.name === cmd)) return launch(cmd, args);
      die(`Unknown command or profile "${cmd}".\n\n${HELP}`);
    }
  }
}

main().catch((e) => die(`multiclaude: ${(e as Error).stack ?? e}`));
