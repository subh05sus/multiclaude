import { join } from 'node:path';
import { LIVE_USAGE_DIR } from './paths.ts';
import { readJson, writeJson } from './util.ts';
import { readClaudeCredentials } from './keychain.ts';
import { configDirEnv } from './profiles.ts';

export interface UsageWindow {
  /** Percent of the window used, 0-100. */
  pct: number;
  /** When the window resets, in epoch milliseconds. */
  resetsAt?: number;
}

export type UsageSource = 'api' | 'statusline' | 'relay';

export interface Usage {
  fiveHour?: UsageWindow;
  sevenDay?: UsageWindow;
  /** Per-model weekly windows, such as opus or sonnet, when the plan has them. */
  models?: Record<string, UsageWindow>;
  /** Paid extra usage on the plan, when it is turned on. */
  extra?: { enabled: boolean; usedUsd?: number; limitUsd?: number; pct?: number };
  /** True when Anthropic says this account is blocked until a reset. */
  limited?: boolean;
  source: UsageSource;
  at: number;
  error?: 'signed-out' | 'token-expired' | 'fetch-failed' | 'no-data';
}

const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';

function toMs(v: unknown): number | undefined {
  if (v == null || v === '') return undefined;
  if (typeof v === 'number') return v < 1e12 ? v * 1000 : v;
  const t = Date.parse(String(v));
  return Number.isNaN(t) ? undefined : t;
}

function win(v: unknown): UsageWindow | undefined {
  if (!v || typeof v !== 'object') return undefined;
  const o = v as Record<string, unknown>;
  const pct = Number(o.utilization ?? o.used_percentage ?? o.pct);
  if (!Number.isFinite(pct)) return undefined;
  // The usage endpoint and the status line both report 0-100.
  return { pct: Math.max(0, Math.min(100, pct)), resetsAt: toMs(o.resets_at ?? o.resetsAt) };
}

/** Parse the claude.ai usage endpoint's reply. Unknown fields are ignored. */
export function parseUsageResponse(body: Record<string, unknown>): Usage {
  const models: Record<string, UsageWindow> = {};
  for (const [k, v] of Object.entries(body)) {
    const m = /^seven_day_(.+)$/.exec(k);
    if (m && m[1] !== 'oauth_apps') {
      const w = win(v);
      if (w) models[m[1]] = w;
    }
  }
  const ex = body.extra_usage as Record<string, unknown> | null | undefined;
  return {
    fiveHour: win(body.five_hour),
    sevenDay: win(body.seven_day),
    models: Object.keys(models).length ? models : undefined,
    extra: ex
      ? {
          enabled: Boolean(ex.is_enabled),
          usedUsd: ex.used_credits != null ? Number(ex.used_credits) / 100 : undefined,
          limitUsd: ex.monthly_limit != null ? Number(ex.monthly_limit) / 100 : undefined,
          pct: ex.utilization != null ? Number(ex.utilization) : undefined,
        }
      : undefined,
    source: 'api',
    at: Date.now(),
  };
}

/**
 * Ask Anthropic how much of a plan is used. Reads the login Claude Code saved; never
 * refreshes it (a refresh would rotate the token under a running session), so an
 * expired login just reports "token-expired" until that account's next session.
 */
export async function fetchUsage(name: string): Promise<Usage> {
  const creds = await readClaudeCredentials(configDirEnv(name));
  const o = creds?.claudeAiOauth;
  if (!o?.accessToken) return { source: 'api', at: Date.now(), error: 'signed-out' };
  if (o.expiresAt && o.expiresAt < Date.now() + 30_000) return { source: 'api', at: Date.now(), error: 'token-expired' };
  try {
    const res = await fetch(USAGE_URL, {
      headers: {
        authorization: `Bearer ${o.accessToken}`,
        'anthropic-beta': 'oauth-2025-04-20',
        'content-type': 'application/json',
        'user-agent': 'multiclaude/0.1',
      },
      signal: AbortSignal.timeout(10_000),
    });
    if (res.status === 401) return { source: 'api', at: Date.now(), error: 'token-expired' };
    if (!res.ok) return { source: 'api', at: Date.now(), error: 'fetch-failed' };
    return parseUsageResponse((await res.json()) as Record<string, unknown>);
  } catch {
    return { source: 'api', at: Date.now(), error: 'fetch-failed' };
  }
}

/** The last good reading from Anthropic's usage endpoint, per profile (written by the service). */
export function apiUsageFile(name: string): string {
  return join(LIVE_USAGE_DIR, '..', 'usage-api', `${name}.json`);
}
export function readApiUsage(name: string): Usage | null {
  return readJson<Usage | null>(apiUsageFile(name), null);
}
export function writeApiUsage(name: string, u: Usage): void {
  writeJson(apiUsageFile(name), u);
}

/**
 * Does a reading belong to this profile's account? Reset times are per account, so a
 * reading whose weekly (or 5-hour) reset is far from what Anthropic reported for the profile
 * came from another login, such as a session started before you switched accounts by hand.
 * Returns undefined when there's nothing to compare.
 */
export function readingFits(reading: Usage, api: Usage | null, now = Date.now()): boolean | undefined {
  if (!api || api.error) return undefined;
  const close = (a?: number, b?: number) => (a && b && b > now ? Math.abs(a - b) < 10 * 60_000 : undefined);
  const week = close(reading.sevenDay?.resetsAt, api.sevenDay?.resetsAt);
  if (week !== undefined) return week;
  return close(reading.fiveHour?.resetsAt, api.fiveHour?.resetsAt);
}

/** Which profile a reading belongs to: the session's own, another that fits, or null for none. */
export function ownerOf(envProfile: string, reading: Usage, names: string[], api: (n: string) => Usage | null = readApiUsage): string | null {
  if (readingFits(reading, api(envProfile)) !== false) return envProfile;
  return names.find((n) => n !== envProfile && readingFits(reading, api(n)) === true) ?? null;
}

/** Usage that the status line or relay reported for a profile. */
export function liveUsageFile(name: string): string {
  return join(LIVE_USAGE_DIR, `${name}.json`);
}

export function readLiveUsage(name: string): Usage | null {
  return readJson<Usage | null>(liveUsageFile(name), null);
}

export function writeLiveUsage(name: string, u: Usage): void {
  const prev = readLiveUsage(name);
  writeJson(liveUsageFile(name), { ...(prev ?? {}), ...stripUndefined(u) });
}

function stripUndefined<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}

/** A window whose reset time has passed is back to zero. */
function current(w: UsageWindow | undefined, now: number): UsageWindow | undefined {
  if (!w) return undefined;
  if (w.resetsAt && w.resetsAt <= now) return { pct: 0 };
  return w;
}

/** Combine sources: the freshest reading of each window wins. */
export function mergeUsage(list: (Usage | null | undefined)[], now = Date.now()): Usage {
  const ok = list.filter((u): u is Usage => Boolean(u)).sort((a, b) => a.at - b.at);
  const out: Usage = { source: 'api', at: 0 };
  for (const u of ok) {
    if (u.error) {
      if (!out.at) out.error = u.error;
      continue;
    }
    out.error = undefined;
    out.at = Math.max(out.at, u.at);
    out.source = u.source;
    if (u.fiveHour) out.fiveHour = u.fiveHour;
    if (u.sevenDay) out.sevenDay = u.sevenDay;
    if (u.models) out.models = { ...(out.models ?? {}), ...u.models };
    if (u.extra) out.extra = u.extra;
    if (u.limited !== undefined) out.limited = u.limited;
  }
  out.fiveHour = current(out.fiveHour, now);
  out.sevenDay = current(out.sevenDay, now);
  if (out.models) for (const k of Object.keys(out.models)) out.models[k] = current(out.models[k], now)!;
  if (out.limited) {
    const resets = [out.fiveHour?.resetsAt, out.sevenDay?.resetsAt].filter(Boolean) as number[];
    if (resets.length && Math.min(...resets) <= now) out.limited = false;
  }
  if (!ok.length) out.error = 'no-data';
  return out;
}

/** The higher of the 5-hour and weekly levels: what decides whether an account has room. */
export function peakPct(u: Usage | undefined): number | undefined {
  if (!u) return undefined;
  const vals = [u.fiveHour?.pct, u.sevenDay?.pct].filter((v): v is number => typeof v === 'number');
  if (u.limited) return 100;
  return vals.length ? Math.max(...vals) : undefined;
}

/** Read the unified rate-limit headers Anthropic sends on every reply. */
export function usageFromHeaders(h: Record<string, string | string[] | undefined>): Usage | null {
  const get = (k: string) => {
    const v = h[`anthropic-ratelimit-unified-${k}`];
    return Array.isArray(v) ? v[0] : v;
  };
  const u5 = get('5h-utilization');
  const u7 = get('7d-utilization');
  const status = get('status');
  if (u5 === undefined && u7 === undefined && status === undefined) return null;
  // Headers carry a 0-1 fraction.
  const pct = (v?: string) => (v === undefined ? undefined : Math.min(100, Number(v) <= 1 ? Number(v) * 100 : Number(v)));
  const usage: Usage = { source: 'relay', at: Date.now() };
  if (u5 !== undefined) usage.fiveHour = { pct: pct(u5)!, resetsAt: toMs(Number(get('5h-reset'))) };
  if (u7 !== undefined) usage.sevenDay = { pct: pct(u7)!, resetsAt: toMs(Number(get('7d-reset'))) };
  if (status) usage.limited = status === 'rejected';
  return usage;
}
