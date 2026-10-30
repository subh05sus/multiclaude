import type { Config } from './config.ts';
import { peakPct, type Usage } from './usage.ts';

export interface Candidate {
  name: string;
  loggedIn: boolean;
  usage?: Usage;
}

export interface PickResult {
  /** The account to use, or null when every account is full or paused. */
  name: string | null;
  /** Why, in plain words, for the CLI and dashboard. */
  reason: string;
  /** Accounts in the order they were considered, each with whether it has room. */
  ranked: { name: string; room: boolean; peak?: number; skip?: string }[];
}

export function switchAtFor(cfg: Config, name: string): number {
  return cfg.profiles.find((p) => p.name === name)?.switchAt ?? cfg.switchAt;
}

/**
 * Choose an account at launch. In "priority" mode it's the first account in your
 * order that is under its switch-at level; in "most-room" mode it's the one with the
 * lowest usage. An account with no usage reading yet counts as having room.
 */
export function pickAccount(cfg: Config, cands: Candidate[], exclude: string[] = []): PickResult {
  const byName = new Map(cands.map((c) => [c.name, c]));
  const ranked: PickResult['ranked'] = [];
  for (const p of cfg.profiles) {
    const c = byName.get(p.name);
    const peak = peakPct(c?.usage);
    let skip: string | undefined;
    if (exclude.includes(p.name)) skip = 'current';
    else if (p.paused) skip = 'paused';
    else if (!c?.loggedIn) skip = 'signed out';
    else if (peak !== undefined && peak >= switchAtFor(cfg, p.name)) skip = `at ${Math.round(peak)}%`;
    ranked.push({ name: p.name, room: !skip, peak, skip });
  }
  const open = ranked.filter((r) => r.room);
  if (!open.length) return { name: null, reason: 'Every account is full, paused or signed out.', ranked };

  if (cfg.pick === 'most-room') {
    const best = [...open].sort((a, b) => (a.peak ?? 0) - (b.peak ?? 0))[0];
    return { name: best.name, reason: `${best.name} has the most room left`, ranked };
  }
  const first = open[0];
  const skipped = ranked.slice(0, ranked.indexOf(first)).filter((r) => r.skip && r.skip !== 'current');
  const why = skipped.length ? ` (skipped ${skipped.map((s) => `${s.name}: ${s.skip}`).join(', ')})` : '';
  return { name: first.name, reason: `${first.name} is first in your order with room${why}`, ranked };
}

/** Move a profile to a new position in the priority order. */
export function reorder(cfg: Config, order: string[]): void {
  const known = new Map(cfg.profiles.map((p) => [p.name, p]));
  const next = order.filter((n) => known.has(n)).map((n) => known.get(n)!);
  for (const p of cfg.profiles) if (!order.includes(p.name)) next.push(p);
  cfg.profiles = next;
}
