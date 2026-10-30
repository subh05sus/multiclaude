import { CONFIG_FILE, DEFAULT_PORT, MAIN_PROFILE } from './paths.ts';
import { readJson, writeJson } from './util.ts';

/**
 * Profiles are kept in priority order: the first entry is tried first.
 * The API key fallback, when on, always comes after every profile.
 */
export interface ProfileConfig {
  name: string;
  /** Short note shown under the name, such as "Work Max". */
  label?: string;
  /** Paused profiles stay set up but are skipped when picking an account. */
  paused?: boolean;
  /** Usage level (percent of the 5-hour or weekly window) at which this account counts as full. */
  switchAt?: number;
  /** Chart colour slot, fixed when the profile is added so reordering never repaints it. */
  color?: number;
}

export type PickMode = 'priority' | 'most-room';

export interface FallbackConfig {
  /** Route launches through the local relay so a paid API key can take over at the limit. */
  enabled: boolean;
  /** Highest API spend per calendar day, in US dollars. 0 means no fallback spend at all. */
  dailyCapUsd: number;
  /** Tell Claude Code the relay is Anthropic's API, so no first-party features switch off. */
  assumeFirstParty: boolean;
  /** Profiles that may use the API key. Empty means all of them. */
  profiles: string[];
}

export interface AlertConfig {
  enabled: boolean;
  /** Usage levels, in percent, that trigger a notification. */
  thresholds: number[];
  /** Also notify when a window that crossed a threshold resets. */
  notifyReset: boolean;
}

export interface AutoResumeConfig {
  /** When a session stops at a usage limit, wait for that account to reset, then continue it. */
  enabled: boolean;
  /** Give up after this long (a weekly limit can be days away). */
  maxWaitHours: number;
}

export interface Config {
  version: 1;
  port: number;
  /** Used when picking is off, or when no account has room. */
  defaultProfile: string;
  /** How `mc` with no name picks an account: first in order with room, or most room left. */
  pick: PickMode;
  /** Default "switch at" level for profiles that don't set their own. */
  switchAt: number;
  profiles: ProfileConfig[];
  fallback: FallbackConfig;
  alerts: AlertConfig;
  autoResume: AutoResumeConfig;
  /** Minutes between usage checks for accounts with no open session. */
  pollMinutes: number;
  terminalApp: 'Terminal' | 'iTerm';
  /** A status line command you had before multiclaude; its output is shown first. */
  statuslineWrap?: string;
  /** Path to the claude binary, when it isn't on PATH. */
  claudePath?: string;
}

export function defaultConfig(): Config {
  return {
    version: 1,
    port: DEFAULT_PORT,
    defaultProfile: MAIN_PROFILE,
    pick: 'priority',
    switchAt: 90,
    profiles: [{ name: MAIN_PROFILE }],
    fallback: { enabled: false, dailyCapUsd: 5, assumeFirstParty: true, profiles: [] },
    alerts: { enabled: true, thresholds: [80, 95], notifyReset: true },
    autoResume: { enabled: true, maxWaitHours: 192 },
    pollMinutes: 5,
    terminalApp: 'Terminal',
  };
}

export function loadConfig(): Config {
  const base = defaultConfig();
  const saved = readJson<Partial<Config>>(CONFIG_FILE, {});
  const cfg: Config = {
    ...base,
    ...saved,
    fallback: { ...base.fallback, ...(saved.fallback ?? {}) },
    alerts: { ...base.alerts, ...(saved.alerts ?? {}) },
    autoResume: { ...base.autoResume, ...(saved.autoResume ?? {}) },
    profiles: saved.profiles?.length ? saved.profiles : base.profiles,
  };
  if (!cfg.profiles.some((p) => p.name === MAIN_PROFILE)) cfg.profiles.unshift({ name: MAIN_PROFILE });
  if (!cfg.profiles.some((p) => p.name === cfg.defaultProfile)) cfg.defaultProfile = MAIN_PROFILE;
  for (const p of cfg.profiles) {
    if (p.color !== undefined) continue;
    const used = new Set(cfg.profiles.map((x) => x.color));
    let slot = 0;
    while (used.has(slot) && slot < 5) slot++;
    p.color = slot;
  }
  return cfg;
}

export function saveConfig(cfg: Config): void {
  writeJson(CONFIG_FILE, cfg);
}

export function updateConfig(fn: (cfg: Config) => void): Config {
  const cfg = loadConfig();
  fn(cfg);
  saveConfig(cfg);
  return cfg;
}

export function fallbackAllowed(cfg: Config, profile: string): boolean {
  return cfg.fallback.enabled && (cfg.fallback.profiles.length === 0 || cfg.fallback.profiles.includes(profile));
}
