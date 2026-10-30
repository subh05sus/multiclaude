import { spawnSync } from 'node:child_process';
import { loadConfig } from './config.ts';
import { profileFromEnv } from './profiles.ts';
import { readState } from './state.ts';
import { writeLiveUsage, ownerOf, type Usage, type UsageWindow } from './usage.ts';
import { recordSessionStart } from './sessions.ts';

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return '';
  const parts: Buffer[] = [];
  for await (const c of process.stdin) parts.push(c as Buffer);
  return Buffer.concat(parts).toString('utf8');
}

const DIM = '\x1b[2m';
const RESET = '\x1b[0m';
function tone(pct: number): string {
  if (pct >= 90) return '\x1b[31m';
  if (pct >= 70) return '\x1b[33m';
  return '\x1b[32m';
}
function pctText(w?: UsageWindow): string {
  if (!w) return `${DIM}—${RESET}`;
  return `${tone(w.pct)}${Math.round(w.pct)}%${RESET}`;
}
function win(v: unknown): UsageWindow | undefined {
  const o = v as { used_percentage?: number; resets_at?: number } | undefined;
  if (!o || typeof o.used_percentage !== 'number') return undefined;
  return { pct: o.used_percentage, resetsAt: o.resets_at ? o.resets_at * 1000 : undefined };
}

/**
 * Claude Code runs this after each reply and passes the session's data on stdin,
 * including the plan's 5-hour and weekly usage. We save that reading for the dashboard
 * and print one line: this account, then the others in your order.
 */
export async function statusline(): Promise<void> {
  const raw = await readStdin();
  const cfg = loadConfig();
  const envProfile = profileFromEnv();
  let input: Record<string, unknown> = {};
  try {
    input = raw ? JSON.parse(raw) : {};
  } catch {
    /* print what we can */
  }

  const rl = input.rate_limits as Record<string, unknown> | undefined;
  const mine: Usage | null = rl ? { source: 'statusline', at: Date.now(), fiveHour: win(rl.five_hour), sevenDay: win(rl.seven_day) } : null;
  // A session keeps the login it started with. If this one started before you switched
  // accounts, its usage belongs to another account: file it there, or nowhere.
  let profile = envProfile;
  let note = '';
  if (mine && (mine.fiveHour || mine.sevenDay)) {
    const owner = ownerOf(envProfile, mine, cfg.profiles.map((p) => p.name));
    if (owner && owner !== envProfile) {
      profile = owner;
      note = ` ${DIM}(older login)${RESET}`;
    } else if (!owner) {
      note = ` \x1b[33m⚠ signed in to another account; restart this session${RESET}`;
    }
    try {
      if (owner) writeLiveUsage(owner, mine);
    } catch {
      /* the line still prints */
    }
  }

  const out: string[] = [];
  if (cfg.statuslineWrap) {
    const r = spawnSync('/bin/sh', ['-c', cfg.statuslineWrap], { input: raw, encoding: 'utf8', timeout: 3000 });
    const prev = (r.stdout ?? '').trim();
    if (prev) out.push(prev);
  }

  const state = readState();
  const me = state?.profiles.find((p) => p.name === profile);
  const five = mine?.fiveHour ?? me?.usage.fiveHour;
  const week = mine?.sevenDay ?? me?.usage.sevenDay;
  let line = `\x1b[1m◆ ${profile}${RESET}${note} ${DIM}5h${RESET} ${pctText(five)} ${DIM}wk${RESET} ${pctText(week)}`;
  if (me?.fallback.active) line += ` \x1b[35m● API key${RESET}`;

  const others = (state?.profiles ?? []).filter((p) => p.name !== profile && !p.paused && p.info.loggedIn);
  if (others.length) {
    const bits = others.slice(0, 3).map((p) => `${p.name} ${p.peak === undefined ? `${DIM}—${RESET}` : `${tone(p.peak)}${Math.round(p.peak)}%${RESET}`}`);
    line += `  ${DIM}│${RESET} ${bits.join(`${DIM} · ${RESET}`)}`;
  }
  const peak = Math.max(five?.pct ?? 0, week?.pct ?? 0);
  const at = me?.switchAt ?? cfg.switchAt;
  if (peak >= at && state?.pick.name && state.pick.name !== profile) line += `  ${DIM}→ mc next${RESET}`;
  out.push(line);
  process.stdout.write(out.join(' ') + '\n');
}

/** SessionStart hook: remember which account each session runs on. */
export async function sessionStartHook(): Promise<void> {
  const raw = await readStdin();
  try {
    const d = JSON.parse(raw) as { session_id?: string; cwd?: string; source?: string };
    if (d.session_id) recordSessionStart({ at: new Date().toISOString(), sessionId: d.session_id, profile: profileFromEnv(), cwd: d.cwd, source: d.source });
  } catch {
    /* never block a session */
  }
}
