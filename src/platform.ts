import { spawn, spawnSync, execFile, type SpawnOptions, type ChildProcess, type SpawnSyncReturns } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { HOME, MC_DIR, REPO_DIR } from './paths.ts';

export const IS_WIN = process.platform === 'win32';
export const IS_MAC = process.platform === 'darwin';

/** Forward slashes work in cmd, PowerShell and Git Bash alike, and need no escaping. */
export function fwd(p: string): string {
  return IS_WIN ? p.replace(/\\/g, '/') : p;
}

/** The command line that runs the CLI with this Node, for settings.json, shell files and autostart. */
export function cliCommand(...args: string[]): string {
  const node = fwd(process.execPath);
  const cli = fwd(join(REPO_DIR, 'src', 'cli.ts'));
  return [`"${node}"`, '--disable-warning=ExperimentalWarning', `"${cli}"`, ...args].join(' ');
}

/** The `mc` launcher to put in commands a person reads: mc.cmd on Windows, bin/mc elsewhere. */
export function mcLauncher(): string {
  return IS_WIN ? fwd(join(HOME, '.local', 'bin', 'mc.cmd')) : join(REPO_DIR, 'bin', 'mc');
}

/** Quote one argument for cmd.exe. */
export function cmdQuote(s: string): string {
  if (/^[\w@%+=:,./\\-]+$/.test(s)) return s;
  return `"${s.replace(/"/g, '""')}"`;
}

let resolved: string | null = null;
/** Find the claude executable. On Windows it may be claude.exe (native) or claude.cmd (npm). */
export function claudeExecutable(configured?: string): string {
  if (configured) return configured;
  if (!IS_WIN) return 'claude';
  if (resolved) return resolved;
  const r = spawnSync('where', ['claude'], { encoding: 'utf8' });
  const hits = (r.stdout ?? '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  resolved = hits.find((h) => /\.exe$/i.test(h)) ?? hits.find((h) => /\.(cmd|bat)$/i.test(h)) ?? 'claude';
  return resolved;
}

/**
 * Windows can't spawn a .cmd/.bat directly (Node refuses without a shell), so those go through
 * cmd.exe with each argument quoted. Everything else is spawned directly.
 */
function plan(exe: string, args: string[]): { cmd: string; args: string[]; verbatim: boolean } {
  if (IS_WIN && /\.(cmd|bat)$/i.test(exe)) {
    const line = [cmdQuote(exe), ...args.map(cmdQuote)].join(' ');
    return { cmd: process.env.ComSpec || 'cmd.exe', args: ['/d', '/s', '/c', `"${line}"`], verbatim: true };
  }
  return { cmd: exe, args, verbatim: false };
}

export function spawnClaude(exe: string, args: string[], opts: SpawnOptions): ChildProcess {
  const p = plan(exe, args);
  return spawn(p.cmd, p.args, { ...opts, windowsVerbatimArguments: p.verbatim });
}

export function spawnClaudeSync(exe: string, args: string[], opts: Parameters<typeof spawnSync>[2] = {}): SpawnSyncReturns<Buffer | string> {
  const p = plan(exe, args);
  return spawnSync(p.cmd, p.args, { ...opts, windowsVerbatimArguments: p.verbatim });
}

/** Is a command on PATH? */
export function onPath(name: string): string | null {
  const r = IS_WIN ? spawnSync('where', [name], { encoding: 'utf8' }) : spawnSync('/bin/sh', ['-c', `command -v ${name}`], { encoding: 'utf8' });
  return r.status === 0 ? (r.stdout ?? '').split(/\r?\n/)[0].trim() || null : null;
}

/** Open a new terminal window running a command (macOS Terminal/iTerm, Windows Terminal or cmd, common Linux terminals). */
export function openInTerminal(command: string, app = 'Terminal'): Promise<void> {
  return new Promise((resolve, reject) => {
    const done = (err: Error | null) => (err ? reject(err) : resolve());
    if (IS_MAC) {
      const script = app === 'iTerm'
        ? 'on run argv\ntell application "iTerm"\nactivate\ncreate window with default profile command "/bin/zsh -lc " & quoted form of (item 1 of argv)\nend tell\nend run'
        : 'on run argv\ntell application "Terminal"\nactivate\ndo script (item 1 of argv)\nend tell\nend run';
      return execFile('osascript', ['-e', script, command], done);
    }
    if (IS_WIN) {
      // Windows Terminal when installed, else a classic console window.
      if (onPath('wt')) return execFile('wt', ['-w', '0', 'nt', 'cmd', '/k', command], { windowsVerbatimArguments: false }, done);
      const child = spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/c', 'start', '"multiclaude"', 'cmd', '/k', command], { detached: true, stdio: 'ignore', windowsVerbatimArguments: true });
      child.on('error', reject);
      child.unref();
      return resolve();
    }
    for (const term of ['x-terminal-emulator', 'gnome-terminal', 'konsole', 'xterm']) {
      if (!onPath(term)) continue;
      const args = term === 'gnome-terminal' ? ['--', 'bash', '-lc', `${command}; exec bash`] : ['-e', 'bash', '-lc', `${command}; exec bash`];
      const child = spawn(term, args, { detached: true, stdio: 'ignore' });
      child.on('error', reject);
      child.unref();
      return resolve();
    }
    reject(new Error(`No terminal found. Run this yourself: ${command}`));
  });
}

/** Stop the background service using the pid it wrote at start. */
export function stopDaemon(): boolean {
  const pidFile = join(MC_DIR, 'daemon.pid');
  if (!existsSync(pidFile)) return false;
  const pid = Number(readFileSync(pidFile, 'utf8').trim());
  rmSync(pidFile, { force: true });
  if (!pid) return false;
  try {
    process.kill(pid);
    return true;
  } catch {
    return false;
  }
}
