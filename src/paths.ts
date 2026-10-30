import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const HOME = homedir();
/** Claude Code's default config folder. The first account lives here. */
export const MAIN_CLAUDE_DIR = process.env.MC_MAIN_CLAUDE_DIR || join(HOME, '.claude');
/** Claude Code's default global state file (outside ~/.claude). */
export const MAIN_CLAUDE_JSON = process.env.MC_MAIN_CLAUDE_JSON || join(HOME, '.claude.json');

export const MC_DIR = process.env.MC_HOME || join(HOME, '.multiclaude');
export const PROFILES_DIR = join(MC_DIR, 'profiles');
export const CONFIG_FILE = join(MC_DIR, 'config.json');
export const SECRET_FILE = join(MC_DIR, 'secret');
export const STATE_FILE = join(MC_DIR, 'state.json');
export const LIVE_USAGE_DIR = join(MC_DIR, 'usage-live');
export const SESSION_MAP_FILE = join(MC_DIR, 'session-map.jsonl');
export const ACTIVITY_FILE = join(MC_DIR, 'activity.jsonl');
export const SPEND_FILE = join(MC_DIR, 'spend.json');
export const STATS_CACHE_FILE = join(MC_DIR, 'cache', 'stats.json');
export const HANDOVER_DIR = join(MC_DIR, 'handovers');
export const LOG_FILE = join(MC_DIR, 'daemon.log');

export const REPO_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
export const WEB_DIR = join(REPO_DIR, 'web');
export const MC_BIN = join(REPO_DIR, 'bin', 'mc');

export const DEFAULT_PORT = 4880;
export const MAIN_PROFILE = 'main';
