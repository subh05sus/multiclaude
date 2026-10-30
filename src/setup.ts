import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, symlinkSync, rmSync, lstatSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { HOME, MAIN_CLAUDE_DIR, MC_BIN, MC_DIR, REPO_DIR, LOG_FILE } from './paths.ts';
import { loadConfig, saveConfig } from './config.ts';
import { logActivity } from './util.ts';

const SETTINGS = () => join(MAIN_CLAUDE_DIR, 'settings.json');
const STATUS_CMD = `${MC_BIN} statusline`;
const HOOK_CMD = `${MC_BIN} hook session-start`;
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

/** Put `mc` on PATH through ~/.local/bin, where Claude Code's own launcher lives. */
export function installBinLink(): string | null {
  const dir = join(HOME, '.local', 'bin');
  const link = join(dir, 'mc');
  mkdirSync(dir, { recursive: true });
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

/** Keep the background service running from login. */
export function installDaemonAgent(): void {
  // Stop a copy started by hand so the agent can take the port.
  spawnSync('pkill', ['-f', `${join(REPO_DIR, 'src', 'cli.ts')} daemon`], { stdio: 'ignore' });
  loadAgent(DAEMON_LABEL, plist(DAEMON_LABEL, [process.execPath, '--disable-warning=ExperimentalWarning', join(REPO_DIR, 'src', 'cli.ts'), 'daemon'], true));
}

/** Compile the Swift menu bar app and open it at login. */
export function installMenubar(): string | null {
  const r = spawnSync('sh', [join(REPO_DIR, 'menubar', 'build.sh'), MENUBAR_APP], { encoding: 'utf8' });
  if (r.status !== 0) return (r.stderr || r.stdout || 'build failed').trim().split('\n').slice(-5).join('\n');
  loadAgent(MENUBAR_LABEL, plist(MENUBAR_LABEL, [join(MENUBAR_APP, 'Contents', 'MacOS', 'MultiClaude')], false));
  return null;
}

export function uninstallAgents(): void {
  unloadAgent(MENUBAR_LABEL);
  unloadAgent(DAEMON_LABEL);
}
