import { spawn } from 'node:child_process';
import { openSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fallbackAllowed, loadConfig, type Config } from './config.ts';
import { LOG_FILE, MC_DIR, REPO_DIR } from './paths.ts';
import { configDirEnv, ensureLinks, syncClaudeJson, isMain } from './profiles.ts';
import { getSecret, logActivity } from './util.ts';

export async function daemonUp(port: number): Promise<boolean> {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/api/ping`, { signal: AbortSignal.timeout(700) });
    return r.ok;
  } catch {
    return false;
  }
}

/** Start the background service if it isn't running (the LaunchAgent normally keeps it up). */
export async function ensureDaemon(cfg: Config = loadConfig()): Promise<boolean> {
  if (await daemonUp(cfg.port)) return true;
  mkdirSync(MC_DIR, { recursive: true, mode: 0o700 });
  const log = openSync(LOG_FILE, 'a');
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', join(REPO_DIR, 'src', 'cli.ts'), 'daemon'], {
    detached: true,
    stdio: ['ignore', log, log],
  });
  child.unref();
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 200));
    if (await daemonUp(cfg.port)) return true;
  }
  return false;
}

export function relayUrl(cfg: Config, profile: string): string {
  return `http://127.0.0.1:${cfg.port}/relay/${getSecret()}/${profile}`;
}

/** The environment that points Claude Code at one profile. */
export function profileEnv(cfg: Config, profile: string, base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base, MC_PROFILE: profile };
  const dir = configDirEnv(profile);
  if (dir) env.CLAUDE_CONFIG_DIR = dir;
  else delete env.CLAUDE_CONFIG_DIR;
  // Drop a relay address inherited from a parent session; keep any address you set yourself.
  if (env.ANTHROPIC_BASE_URL?.includes('/relay/')) {
    delete env.ANTHROPIC_BASE_URL;
    delete env._CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL;
  }
  if (fallbackAllowed(cfg, profile) && !env.ANTHROPIC_BASE_URL) {
    env.ANTHROPIC_BASE_URL = relayUrl(cfg, profile);
    if (cfg.fallback.assumeFirstParty) env._CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL = '1';
  }
  return env;
}

export interface LaunchOptions {
  /** Shown before Claude starts, such as why this account was picked. */
  reason?: string;
  quiet?: boolean;
}

/** Run Claude Code on a profile in this terminal and exit with its exit code. */
export async function launch(profile: string, args: string[], opts: LaunchOptions = {}): Promise<never> {
  const cfg = loadConfig();
  if (!cfg.profiles.some((p) => p.name === profile)) {
    console.error(`No profile called "${profile}". Run "mc list" to see them, or "mc add ${profile}" to add it.`);
    process.exit(1);
  }
  if (!isMain(profile)) {
    ensureLinks(profile);
    syncClaudeJson(profile);
  }
  const usesRelay = fallbackAllowed(cfg, profile);
  const up = await ensureDaemon(cfg);
  if (usesRelay && !up) {
    console.error('The multiclaude service did not start, and the API-key fallback needs it. Check ~/.multiclaude/daemon.log, or turn the fallback off with "mc fallback off".');
    process.exit(1);
  }
  if (process.env.ANTHROPIC_API_KEY && !opts.quiet) {
    console.error('Note: ANTHROPIC_API_KEY is set in this shell, so Claude Code will bill that key instead of your plan. Unset it to use the plan.');
  }
  const env = profileEnv(cfg, profile);
  // The one-line banner is for people, so only on a terminal (scripts using `claude -p` stay clean).
  if (!opts.quiet && process.stderr.isTTY) {
    const tty = true;
    const bold = (s: string) => (tty ? `\x1b[1m${s}\x1b[0m` : s);
    const dim = (s: string) => (tty ? `\x1b[2m${s}\x1b[0m` : s);
    const bits = [bold(profile)];
    if (opts.reason) bits.push(dim(opts.reason));
    if (usesRelay) bits.push(dim(`API fallback on (cap $${cfg.fallback.dailyCapUsd}/day)`));
    console.error(`▸ ${bits.join(' · ')}`);
  }
  logActivity('launch', `Started Claude Code${args.length ? ` (${args.join(' ').slice(0, 80)})` : ''}`, profile);

  const child = spawn(cfg.claudePath || 'claude', args, { stdio: 'inherit', env });
  // Ctrl-C reaches Claude directly; this wrapper just waits.
  const ignore = () => {};
  process.on('SIGINT', ignore);
  process.on('SIGTERM', () => child.kill('SIGTERM'));
  process.on('SIGHUP', () => child.kill('SIGHUP'));
  return new Promise<never>(() => {
    child.on('error', (e) => {
      console.error(`Could not start claude: ${e.message}. Set "claudePath" in ~/.multiclaude/config.json if it isn't on PATH.`);
      process.exit(127);
    });
    child.on('exit', (code, signal) => process.exit(code ?? (signal ? 128 : 0)));
  });
}
