import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, symlinkSync, rmSync, lstatSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { HOME, MAIN_CLAUDE_DIR, MC_BIN, MC_DIR, REPO_DIR, LOG_FILE } from './paths.ts';
import { loadConfig, saveConfig } from './config.ts';
import { logActivity } from './util.ts';
import { IS_WIN, IS_MAC, cliCommand, fwd } from './platform.ts';

const SETTINGS = () => join(MAIN_CLAUDE_DIR, 'settings.json');
// Windows runs these through whatever shell Claude Code uses there, so call Node directly.
const STATUS_CMD = IS_WIN ? cliCommand('statusline') : `${MC_BIN} statusline`;
const HOOK_CMD = IS_WIN ? cliCommand('hook', 'session-start') : `${MC_BIN} hook session-start`;
const LOCAL_BIN = join(HOME, '.local', 'bin');
const AGENTS = join(HOME, 'Library', 'LaunchAgents');
const DAEMON_LABEL = 'com.multiclaude.daemon';
const MENUBAR_LABEL = 'com.multiclaude.menubar';
export const MENUBAR_APP = join(MC_DIR, 'MultiClaude.app');

type Settings = {
  statusLine?: { type: string; command: string; padding?: number };
  hooks?: Record<string, { matcher?: string; hooks: { type: string; command: string; timeout?: number }[] }[]>;
  [k: string]: unknown;
};

function readSettings(): Settings {
  try {
    return JSON.parse(readFileSync(SETTINGS(), 'utf8')) as Settings;
  } catch {
    return {};
  }
}

function writeSettings(s: Settings): void {
  if (existsSync(SETTINGS())) copyFileSync(SETTINGS(), `${SETTINGS()}.mc-backup-${Date.now()}`);
  writeFileSync(SETTINGS(), JSON.stringify(s, null, 2) + '\n');
}

/** Add the status line and the SessionStart hook to the shared settings.json. Returns what changed. */
export function installClaudeSettings(): string[] {
  const s = readSettings();
  const changes: string[] = [];
  const cfg = loadConfig();
  if (s.statusLine?.command !== STATUS_CMD) {
    if (s.statusLine?.command) {
      cfg.statuslineWrap = s.statusLine.command;
      saveConfig(cfg);
      changes.push(`status line (your old one, "${s.statusLine.command}", still shows first)`);
    } else changes.push('status line');
    s.statusLine = { type: 'command', command: STATUS_CMD, padding: 0 };
  }
  s.hooks ??= {};
  const ss = (s.hooks.SessionStart ??= []);
  if (!ss.some((g) => g.hooks?.some((h) => h.command === HOOK_CMD))) {
    ss.push({ hooks: [{ type: 'command', command: HOOK_CMD, timeout: 5 }] });
    changes.push('SessionStart hook (records which account runs each session)');
  }
  if (changes.length) {
    writeSettings(s);
    logActivity('settings', `Added to settings.json: ${changes.join('; ')}`);
  }
  return changes;
}

export function removeClaudeSettings(): string[] {
  const s = readSettings();
  const changes: string[] = [];
  const cfg = loadConfig();
  if (s.statusLine?.command === STATUS_CMD) {
    if (cfg.statuslineWrap) s.statusLine = { type: 'command', command: cfg.statuslineWrap };
    else delete s.statusLine;
    changes.push('status line');
  }
  const ss = s.hooks?.SessionStart;
  if (ss) {
    const kept = ss.filter((g) => !g.hooks?.some((h) => h.command === HOOK_CMD));
    if (kept.length !== ss.length) {
      if (kept.length) s.hooks!.SessionStart = kept;
      else delete s.hooks!.SessionStart;
      changes.push('SessionStart hook');
    }
  }
  if (changes.length) writeSettings(s);
  return changes;
}

function onPathNow(dir: string): boolean {
  const parts = (process.env.PATH ?? '').split(IS_WIN ? ';' : ':');
  return parts.some((p) => (IS_WIN ? p.toLowerCase().replace(/[\\/]+$/, '') === dir.toLowerCase() : p.replace(/\/+$/, '') === dir));
}

/** Put `mc` on PATH through ~/.local/bin, where Claude Code's own launcher lives. */
export function installBinLink(): string | null {
  const dir = LOCAL_BIN;
  mkdirSync(dir, { recursive: true });
  if (IS_WIN) {
    // mc.cmd for cmd and PowerShell; a plain `mc` script for Git Bash.
    writeFileSync(join(dir, 'mc.cmd'), `@echo off\r\n${cliCommand()} %*\r\n`);
    writeFileSync(join(dir, 'mc'), `#!/bin/sh\nexec ${cliCommand()} "$@"\n`);
    return onPathNow(dir) ? null : `Added mc to ${dir}, which isn't on your PATH yet. Add it in Settings → System → About → Advanced system settings → Environment Variables, or run mc from ${fwd(join(REPO_DIR, 'bin'))}.`;
  }
  const link = join(dir, 'mc');
  try {
    const st = lstatSync(link);
    if (!st.isSymbolicLink()) return `${link} already exists and isn't ours; left it alone`;
    rmSync(link);
  } catch {
    /* not there yet */
  }
  symlinkSync(MC_BIN, link);
  return null;
}

function plist(label: string, args: string[], keepAlive: boolean): string {
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${label}</string>
  <key>ProgramArguments</key>
  <array>${args.map((a) => `<string>${esc(a)}</string>`).join('')}</array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key>${keepAlive ? '<true/>' : '<false/>'}
  <key>StandardOutPath</key><string>${esc(LOG_FILE)}</string>
  <key>StandardErrorPath</key><string>${esc(LOG_FILE)}</string>
  <key>EnvironmentVariables</key>
  <dict><key>PATH</key><string>${esc(`${join(HOME, '.local', 'bin')}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin`)}</string></dict>
</dict>
</plist>
`;
}

function loadAgent(label: string, content: string): void {
  mkdirSync(AGENTS, { recursive: true });
  const file = join(AGENTS, `${label}.plist`);
  const uid = process.getuid?.() ?? 501;
  spawnSync('launchctl', ['bootout', `gui/${uid}/${label}`], { stdio: 'ignore' });
  writeFileSync(file, content);
  execFileSync('launchctl', ['bootstrap', `gui/${uid}`, file], { stdio: 'ignore' });
}

export function unloadAgent(label: string): void {
  const uid = process.getuid?.() ?? 501;
  spawnSync('launchctl', ['bootout', `gui/${uid}/${label}`], { stdio: 'ignore' });
  rmSync(join(AGENTS, `${label}.plist`), { force: true });
}

const WIN_STARTUP = () => join(process.env.APPDATA ?? join(HOME, 'AppData', 'Roaming'), 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', 'multiclaude.vbs');
const SYSTEMD_UNIT = join(HOME, '.config', 'systemd', 'user', 'multiclaude.service');

/** Keep the background service running from login: Startup folder (Windows), systemd user unit (Linux), LaunchAgent (macOS). Returns a note. */
export function installAutostart(): string {
  if (IS_WIN) {
    // A tiny VBScript in the Startup folder runs the service hidden at login, no admin rights needed.
    const cmd = cliCommand('daemon').replace(/"/g, '""');
    mkdirSync(join(WIN_STARTUP(), '..'), { recursive: true });
    writeFileSync(WIN_STARTUP(), `CreateObject("WScript.Shell").Run "${cmd}", 0, False\r\n`);
    return 'Background service starts at login (Startup folder: multiclaude.vbs)';
  }
  if (!IS_MAC) {
    if (spawnSync('systemctl', ['--user', '--version'], { stdio: 'ignore' }).status !== 0) return 'No systemd user session: start the service with "mc start" after login';
    mkdirSync(join(SYSTEMD_UNIT, '..'), { recursive: true });
    writeFileSync(SYSTEMD_UNIT, `[Unit]\nDescription=multiclaude\n\n[Service]\nExecStart=${cliCommand('daemon')}\nRestart=on-failure\n\n[Install]\nWantedBy=default.target\n`);
    spawnSync('systemctl', ['--user', 'daemon-reload'], { stdio: 'ignore' });
    spawnSync('systemctl', ['--user', 'enable', '--now', 'multiclaude.service'], { stdio: 'ignore' });
    return 'Background service starts at login (systemd user unit multiclaude.service)';
  }
  installDaemonAgent();
  return 'Background service starts at login (LaunchAgent com.multiclaude.daemon)';
}

export function removeAutostart(): void {
  if (IS_WIN) return void rmSync(WIN_STARTUP(), { force: true });
  if (!IS_MAC) {
    spawnSync('systemctl', ['--user', 'disable', '--now', 'multiclaude.service'], { stdio: 'ignore' });
    return void rmSync(SYSTEMD_UNIT, { force: true });
  }
  unloadAgent(DAEMON_LABEL);
}

/** Keep the background service running from login. */
export function installDaemonAgent(): void {
  // Stop a copy started by hand so the agent can take the port.
  spawnSync('pkill', ['-f', `${join(REPO_DIR, 'src', 'cli.ts')} daemon`], { stdio: 'ignore' });
  loadAgent(DAEMON_LABEL, plist(DAEMON_LABEL, [process.execPath, '--disable-warning=ExperimentalWarning', join(REPO_DIR, 'src', 'cli.ts'), 'daemon'], true));
}

/** Compile the Swift menu bar app and open it at login. */
export function installMenubar(): string | null {
  if (!IS_MAC) return 'skipped: the menu bar app is macOS only (use the dashboard: mc ui)';
  const r = spawnSync('sh', [join(REPO_DIR, 'menubar', 'build.sh'), MENUBAR_APP], { encoding: 'utf8' });
  if (r.status !== 0) return (r.stderr || r.stdout || 'build failed').trim().split('\n').slice(-5).join('\n');
  loadAgent(MENUBAR_LABEL, plist(MENUBAR_LABEL, [join(MENUBAR_APP, 'Contents', 'MacOS', 'MultiClaude')], false));
  return null;
}

export function uninstallAgents(): void {
  if (IS_MAC) unloadAgent(MENUBAR_LABEL);
  removeAutostart();
  if (IS_WIN) {
    rmSync(join(LOCAL_BIN, 'mc.cmd'), { force: true });
    rmSync(join(LOCAL_BIN, 'mc'), { force: true });
  }
}
