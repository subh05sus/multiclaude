import { STATE_FILE } from './paths.ts';
import type { Config, PickMode, AlertConfig } from './config.ts';
import type { ProfileInfo } from './profiles.ts';
import type { Usage } from './usage.ts';
import type { PickResult } from './pick.ts';
import { readJson } from './util.ts';

export interface ProfileState {
  name: string;
  label?: string;
  color: number;
  paused: boolean;
  switchAt: number;
  position: number;
  info: ProfileInfo;
  usage: Usage;
  peak?: number;
  fallback: { active: boolean; until?: number };
}

export interface AppState {
  version: string;
  updatedAt: number;
  port: number;
  pickMode: PickMode;
  switchAt: number;
  defaultProfile: string;
  terminalApp: Config['terminalApp'];
  pollMinutes: number;
  pick: PickResult;
  alerts: AlertConfig;
  fallback: Config['fallback'] & { spentToday: number; hasKey: boolean };
  profiles: ProfileState[];
}

/** The last state the daemon wrote. The status line and the CLI read this when the daemon is busy or off. */
export function readState(): AppState | null {
  return readJson<AppState | null>(STATE_FILE, null);
}
