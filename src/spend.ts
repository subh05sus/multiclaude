import { SPEND_FILE } from './paths.ts';
import { readJson, writeJson, today } from './util.ts';

/** What the paid API key cost, per day and per profile. */
export interface SpendLedger {
  days: Record<string, { total: number; requests: number; byProfile: Record<string, number>; byModel: Record<string, number> }>;
}

export function readSpend(): SpendLedger {
  return readJson<SpendLedger>(SPEND_FILE, { days: {} });
}

export function spentToday(): number {
  return readSpend().days[today()]?.total ?? 0;
}

export function recordSpend(profile: string, model: string, usd: number): void {
  const l = readSpend();
  const d = (l.days[today()] ??= { total: 0, requests: 0, byProfile: {}, byModel: {} });
  d.total += usd;
  d.requests += 1;
  d.byProfile[profile] = (d.byProfile[profile] ?? 0) + usd;
  d.byModel[model] = (d.byModel[model] ?? 0) + usd;
  // Keep 120 days.
  const keys = Object.keys(l.days).sort();
  for (const k of keys.slice(0, Math.max(0, keys.length - 120))) delete l.days[k];
  writeJson(SPEND_FILE, l);
}
