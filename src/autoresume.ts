import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig, type Config } from './config.ts';
import { MC_DIR } from './paths.ts';
import { profileFromEnv } from './profiles.ts';
import { readState } from './state.ts';
import { pickAccount } from './pick.ts';
import { fetchUsage, readApiUsage, readLiveUsage, mergeUsage, type Usage } from './usage.ts';
import { logActivity, notify } from './util.ts';

/**
 * Auto-resume: a StopFailure hook (matcher "rate_limit", asyncRewake) that keeps a stopped
 * session's place and wakes it once **its own account's** limit has reset. It never moves the
 * session to another account; it only tells you which one has room, so `mc next` is one
 * command away if you'd rather not wait.
 */

const WAITERS = join(MC_DIR, 'waiters');
const OFF_FLAG = join(MC_DIR, 'autoresume-off');

export type WaitPlan =
  /** The account is out: wait for this time (the latest reset of the full windows), then confirm. */
  | { kind: 'reset'; at: number; windows: string[] }
  /** Not actually out (a short rate limit): try again soon. */
  | { kind: 'short' }
  /** Out, but no reset time known: keep checking. */
  | { kind: 'unknown' };

const FULL = 99;

export function planWait(u: Usage | null, now = Date.now()): WaitPlan {
  if (!u || u.error) return { kind: 'unknown' };
  const full: [string, number | undefined][] = [];
  if (u.fiveHour && u.fiveHour.pct >= FULL) full.push(['5-hour', u.fiveHour.resetsAt]);
  if (u.sevenDay && u.sevenDay.pct >= FULL) full.push(['weekly', u.sevenDay.resetsAt]);
  for (const [k, w] of Object.entries(u.models ?? {})) if (w && w.pct >= FULL) full.push([`${k} weekly`, w.resetsAt]);
  if (!full.length && !u.limited) return { kind: 'short' };
  const times = full.map(([, t]) => t).filter((t): t is number => typeof t === 'number' && t > now);
  if (!times.length) {
    if (u.limited) {
      const any = [u.fiveHour?.resetsAt, u.sevenDay?.resetsAt].filter((t): t is number => typeof t === 'number' && t > now);
      if (any.length) return { kind: 'reset', at: Math.min(...any), windows: ['plan'] };
    }
    return { kind: 'unknown' };
  }
  return { kind: 'reset', at: Math.max(...times), windows: full.map(([n]) => n) };
}

/** Has the limit lifted? Every window below full and not marked limited. */
export function lifted(u: Usage | null): boolean {
  if (!u || u.error) return false;
  if (u.limited) return false;
  const vals = [u.fiveHour?.pct, u.sevenDay?.pct, ...Object.values(u.models ?? {}).map((w) => w?.pct)].filter((v): v is number => typeof v === 'number');
  return vals.every((v) => v < FULL);
}

export function autoResumeEnabled(cfg: Config = loadConfig()): boolean {
  return cfg.autoResume.enabled && !existsSync(OFF_FLAG);
}

function when(ms: number): string {
  const d = new Date(ms);
  const sameDay = d.toDateString() === new Date().toDateString();
  return sameDay ? d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : d.toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' });
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export interface WaitDeps {
  usage: (profile: string) => Promise<Usage | null>;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  /** False once the Claude Code session that started us is gone. */
  sessionAlive: () => boolean;
  notify: (title: string, body: string) => void;
  log: typeof logActivity;
  nextWithRoom: (exclude: string) => string | null;
  enabled: () => boolean;
}

export interface WaitResult {
  resume: boolean;
  reason: string;
}

/**
 * Wait until the account's limit lifts. Checks Anthropic right after the reset time, then every
 * few minutes (resets can land a little late), and gives up after maxWaitHours.
 */
export async function waitForReset(profile: string, cfg: Config, deps: WaitDeps): Promise<WaitResult> {
  const deadline = deps.now() + cfg.autoResume.maxWaitHours * 3600_000;
  const first = await deps.usage(profile);
  let plan = planWait(first, deps.now());

  if (plan.kind === 'short') {
    deps.log('limit-wait', 'Rate limited briefly; trying again in a minute', profile);
    await deps.sleep(60_000);
    return deps.sessionAlive() && deps.enabled() ? { resume: true, reason: 'a short rate limit' } : { resume: false, reason: 'stopped' };
  }

  const other = deps.nextWithRoom(profile);
  const until = plan.kind === 'reset' ? ` until ${when(plan.at)}` : '';
  const tail = other ? ` Don't want to wait? Run "mc next" to continue on ${other} now.` : '';
  deps.notify('multiclaude', `${profile} is out${until}. This session will continue by itself when it resets.${tail}`);
  deps.log('limit-wait', `Session paused at the limit${until}; will continue when it resets${other ? ` (${other} has room now)` : ''}`, profile);

  const STEP = 5 * 60_000;
  while (deps.now() < deadline) {
    if (!deps.sessionAlive()) return { resume: false, reason: 'the session was closed' };
    if (!deps.enabled()) return { resume: false, reason: 'auto-resume was turned off' };
    const target = plan.kind === 'reset' ? plan.at + 20_000 : deps.now() + STEP;
    const wait = Math.max(5_000, Math.min(STEP, target - deps.now()));
    await deps.sleep(wait);
    if (plan.kind === 'reset' && deps.now() < plan.at + 20_000) continue;
    const u = await deps.usage(profile);
    if (lifted(u)) return { resume: true, reason: 'the limit reset' };
    const next = planWait(u, deps.now());
    plan = next.kind === 'reset' ? next : { kind: 'unknown' };
  }
  return { resume: false, reason: `nothing changed in ${cfg.autoResume.maxWaitHours} hours` };
}

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return '';
  const parts: Buffer[] = [];
  for await (const c of process.stdin) parts.push(c as Buffer);
  return Buffer.concat(parts).toString('utf8');
}

/** The hook entry point: `mc hook limit-wait`. Exit 2 wakes the session (asyncRewake). */
export async function limitWaitHook(): Promise<void> {
  const raw = await readStdin();
  let input: { session_id?: string; error?: string; last_assistant_message?: string } = {};
  try {
    input = raw ? JSON.parse(raw) : {};
  } catch {
    process.exit(0);
  }
  const cfg = loadConfig();
  if (input.error && input.error !== 'rate_limit') process.exit(0);
  if (!autoResumeEnabled(cfg)) process.exit(0);

  const profile = profileFromEnv();
  const sessionId = input.session_id ?? `pid-${process.ppid}`;

  // One waiter per session: a second rate_limit stop while we wait doesn't start another.
  mkdirSync(WAITERS, { recursive: true, mode: 0o700 });
  const lock = join(WAITERS, `${sessionId.replace(/[^\w-]/g, '')}.json`);
  try {
    const prev = JSON.parse(readFileSync(lock, 'utf8')) as { pid: number };
    if (prev.pid && prev.pid !== process.pid && alive(prev.pid)) process.exit(0);
  } catch {
    /* no waiter yet */
  }
  writeFileSync(lock, JSON.stringify({ pid: process.pid, profile, since: new Date().toISOString() }));
  const cleanup = () => rmSync(lock, { force: true });
  process.on('exit', cleanup);
  // Killed (session closed, Claude Code quit, or the timeout hit): leave quietly, no rewake.
  for (const sig of ['SIGTERM', 'SIGHUP', 'SIGINT'] as const) process.on(sig, () => process.exit(0));

  const parent = process.ppid;
  const result = await waitForReset(profile, cfg, {
    usage: async (p) => {
      const api = await fetchUsage(p);
      if (!api.error) return api;
      // Token expired or offline: fall back to what the service and status lines last saw.
      return mergeUsage([readApiUsage(p), readLiveUsage(p)]);
    },
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    now: () => Date.now(),
    sessionAlive: () => process.ppid === parent && alive(parent),
    notify,
    log: logActivity,
    nextWithRoom: (exclude) => {
      const s = readState();
      if (!s) return null;
      return pickAccount(loadConfig(), s.profiles.map((x) => ({ name: x.name, loggedIn: x.info.loggedIn, usage: x.usage })), [exclude]).name;
    },
    enabled: () => autoResumeEnabled(),
  });

  if (!result.resume) {
    logActivity('limit-wait', `Stopped waiting: ${result.reason}`, profile);
    process.exit(0);
  }
  logActivity('resume', `Limit lifted (${result.reason}); continuing the session`, profile);
  notify('multiclaude', `${profile} is ready again. Continuing your session.`);
  process.stderr.write(
    `Auto-resume (multiclaude): the usage limit on this account (${profile}) has lifted. Continue exactly where you left off. Do not repeat work or tool calls that already completed; check their results first if unsure.\n`,
  );
  process.exit(2);
}
