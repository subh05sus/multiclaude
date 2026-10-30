import {
  existsSync, lstatSync, mkdirSync, readlinkSync, symlinkSync, copyFileSync, rmSync, cpSync, statSync, writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { MAIN_CLAUDE_DIR, MAIN_CLAUDE_JSON, PROFILES_DIR, MAIN_PROFILE } from './paths.ts';
import { readJson, writeJson, logActivity } from './util.ts';
import { readClaudeCredentials } from './keychain.ts';

/**
 * Everything in ~/.claude that every account shares. Logins live in the Keychain
 * and per-account state lives in each profile's own .claude.json, so neither is here.
 * Memory is stored inside projects/, so sharing projects/ shares memory too.
 *  - Customisation: skills, commands, agents, hooks, output styles, plugins (with their
 *    data and marketplaces), local-marketplace (directory marketplaces) and dev-mods
 *    (mods: panels, bands, status lines under development).
 *  - What a resumed session needs: projects (transcripts, memory), todos, tasks, plans,
 *    file-history (checkpoints), paste-cache (pasted text), uploads, session-env.
 * Left per account on purpose: sessions/ and jobs/ (background agents of that login),
 * caches, telemetry, statsig and the daemon's own files.
 */
const SHARED_DIRS = [
  'projects', 'todos', 'tasks', 'plans', 'file-history', 'paste-cache', 'uploads', 'session-env',
  'skills', 'commands', 'agents', 'hooks', 'output-styles', 'plugins', 'local-marketplace', 'dev-mods',
];
const SHARED_FILES = ['settings.json', 'CLAUDE.md', 'history.jsonl', 'keybindings.json'];
/** Data folders created in ~/.claude when missing, so sharing works from day one. */
const ALWAYS_CREATE = new Set(['projects', 'todos', 'tasks', 'plans', 'file-history', 'paste-cache', 'skills', 'plugins', 'dev-mods']);

/** Keys copied from ~/.claude.json into a new profile so it skips onboarding and keeps your setup. */
const SEED_KEYS = [
  'hasCompletedOnboarding', 'lastOnboardingVersion', 'theme', 'autoUpdates', 'autoUpdatesProtectedForNative',
  'installMethod', 'hasIdeOnboardingBeenShown', 'optionAsMetaKeyInstalled', 'hasUsedBackslashReturn', 'editorMode',
  'preferredNotifChannel', 'bypassPermissionsModeAccepted', 'hasCompletedClaudeInChromeOnboarding',
  'claudeInChromeDefaultEnabled', 'chromeExtension', 'githubRepoPaths', 'deepLinkTerminal', 'lastReleaseNotesSeen',
];

export function isMain(name: string): boolean {
  return name === MAIN_PROFILE;
}

/** The folder Claude Code uses for this profile. */
export function profileDir(name: string): string {
  return isMain(name) ? MAIN_CLAUDE_DIR : join(PROFILES_DIR, name);
}

/** The CLAUDE_CONFIG_DIR value for this profile, or null to leave it unset. */
export function configDirEnv(name: string): string | null {
  return isMain(name) ? null : resolve(profileDir(name));
}

export function claudeJsonPath(name: string): string {
  return isMain(name) ? MAIN_CLAUDE_JSON : join(profileDir(name), '.claude.json');
}

export function profileExists(name: string): boolean {
  return isMain(name) || existsSync(profileDir(name));
}

/** Work out which profile a Claude Code process belongs to from its environment. */
export function profileFromEnv(env: NodeJS.ProcessEnv = process.env): string {
  if (env.MC_PROFILE) return env.MC_PROFILE;
  const dir = env.CLAUDE_CONFIG_DIR;
  if (!dir) return MAIN_PROFILE;
  const abs = resolve(dir);
  if (abs === resolve(MAIN_CLAUDE_DIR)) return MAIN_PROFILE;
  if (abs.startsWith(resolve(PROFILES_DIR) + '/')) return abs.slice(resolve(PROFILES_DIR).length + 1).split('/')[0];
  return MAIN_PROFILE;
}

function isLinkTo(path: string, target: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink() && resolve(join(path, '..'), readlinkSync(path)) === resolve(target);
  } catch {
    return false;
  }
}

/**
 * Make every shared entry in a profile a link to ~/.claude. If Claude Code saved a
 * file by replacing the link (write to temp, then rename), move the newer copy back
 * into ~/.claude first so nothing is lost. Returns what it fixed.
 */
export function ensureLinks(name: string): string[] {
  if (isMain(name)) return [];
  const dir = profileDir(name);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const fixed: string[] = [];

  for (const entry of [...SHARED_DIRS, ...SHARED_FILES]) {
    const src = join(MAIN_CLAUDE_DIR, entry);
    const dst = join(dir, entry);
    const isDir = SHARED_DIRS.includes(entry);

    if (!existsSync(src)) {
      if (isDir && ALWAYS_CREATE.has(entry)) mkdirSync(src, { recursive: true });
      else if (entry === 'history.jsonl') writeFileSync(src, '', { mode: 0o600 });
      else if (!existsSync(dst)) continue;
    }
    if (isLinkTo(dst, src)) continue;

    let st: ReturnType<typeof lstatSync> | null = null;
    try { st = lstatSync(dst); } catch { st = null; }

    if (st && !st.isSymbolicLink()) {
      // A real file or folder took the link's place. Keep whichever copy is newer.
      if (isDir) {
        if (existsSync(src)) cpSync(dst, src, { recursive: true, force: false, errorOnExist: false });
        else cpSync(dst, src, { recursive: true });
      } else if (!existsSync(src) || statSync(dst).mtimeMs > statSync(src).mtimeMs) {
        if (existsSync(src)) copyFileSync(src, `${src}.mc-backup-${Date.now()}`);
        copyFileSync(dst, src);
      }
      rmSync(dst, { recursive: true, force: true });
      fixed.push(entry);
    } else if (st?.isSymbolicLink()) {
      rmSync(dst, { force: true });
    }
    if (existsSync(src)) symlinkSync(src, dst);
  }
  if (fixed.length) logActivity('heal', `Re-linked ${fixed.join(', ')} to the shared copy`, name);
  return fixed;
}

type ClaudeJson = Record<string, unknown> & {
  mcpServers?: Record<string, unknown>;
  projects?: Record<string, Record<string, unknown>>;
  oauthAccount?: OauthAccount;
};

export interface OauthAccount {
  accountUuid?: string;
  emailAddress?: string;
  displayName?: string;
  organizationName?: string;
  organizationUuid?: string;
  billingType?: string;
  hasExtraUsageEnabled?: boolean;
}

/**
 * Copy your MCP servers, project trust and onboarding state from ~/.claude.json into a
 * profile before it starts. Only the profile's file is written: ~/.claude.json is never
 * touched, because the main account's open sessions rewrite it all the time.
 */
export function syncClaudeJson(name: string): void {
  if (isMain(name)) return;
  const main = readJson<ClaudeJson>(MAIN_CLAUDE_JSON, {});
  const path = claudeJsonPath(name);
  const mine = readJson<ClaudeJson>(path, {});

  for (const key of SEED_KEYS) if (mine[key] === undefined && main[key] !== undefined) mine[key] = main[key];
  // Keep these in step with main every launch: plugin panels (the progress board and other
  // mods) and which official plugins were already set up.
  for (const key of ['pluginPanes', 'officialMarketplaceAutoInstalled', 'officialMarketplaceAutoInstallAttempted']) {
    if (main[key] !== undefined) mine[key] = main[key];
  }
  // Servers added in main win; servers added only in this profile stay.
  mine.mcpServers = { ...(mine.mcpServers ?? {}), ...(main.mcpServers ?? {}) };
  const projects = { ...(mine.projects ?? {}) };
  for (const [proj, settings] of Object.entries(main.projects ?? {})) {
    projects[proj] = { ...settings, ...(projects[proj] ?? {}), mcpServers: { ...((projects[proj]?.mcpServers as object) ?? {}), ...((settings.mcpServers as object) ?? {}) } };
    if (settings.hasTrustDialogAccepted) projects[proj].hasTrustDialogAccepted = true;
  }
  mine.projects = projects;
  writeJson(path, mine);
}

export interface ProfileInfo {
  name: string;
  exists: boolean;
  loggedIn: boolean;
  email?: string;
  displayName?: string;
  organization?: string;
  accountUuid?: string;
  plan?: string;
  tier?: string;
  extraUsage?: boolean;
  tokenExpiresAt?: number;
}

export function planLabel(subscriptionType?: string, tier?: string): string | undefined {
  if (!subscriptionType) return undefined;
  const t = subscriptionType.toLowerCase();
  if (t === 'max') {
    if (tier?.includes('20x')) return 'Max 20x';
    if (tier?.includes('5x')) return 'Max 5x';
    return 'Max';
  }
  return t.charAt(0).toUpperCase() + t.slice(1);
}

export async function profileInfo(name: string): Promise<ProfileInfo> {
  const exists = profileExists(name);
  const acct = readJson<ClaudeJson>(claudeJsonPath(name), {}).oauthAccount ?? {};
  const creds = exists ? await readClaudeCredentials(configDirEnv(name)) : null;
  const o = creds?.claudeAiOauth;
  return {
    name,
    exists,
    loggedIn: Boolean(o?.accessToken),
    email: acct.emailAddress,
    displayName: acct.displayName,
    organization: acct.organizationName,
    accountUuid: acct.accountUuid,
    plan: planLabel(o?.subscriptionType, o?.rateLimitTier),
    tier: o?.rateLimitTier,
    extraUsage: acct.hasExtraUsageEnabled,
    tokenExpiresAt: o?.expiresAt,
  };
}

/** Map each signed-in account's id to its profile, for attributing old sessions. */
export function accountUuidMap(names: string[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const n of names) {
    const id = readJson<ClaudeJson>(claudeJsonPath(n), {}).oauthAccount?.accountUuid;
    if (id) map.set(id, n);
  }
  return map;
}

export function createProfileDir(name: string): void {
  ensureLinks(name);
  syncClaudeJson(name);
}

export function removeProfileDir(name: string): void {
  if (isMain(name)) throw new Error('The main profile is your normal ~/.claude and cannot be removed.');
  // rmSync removes the links themselves, never what they point to.
  rmSync(profileDir(name), { recursive: true, force: true });
}
