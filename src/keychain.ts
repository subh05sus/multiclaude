import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { userInfo } from 'node:os';

/**
 * Claude Code stores each login in the macOS Keychain. The default folder uses
 * "Claude Code-credentials"; a custom CLAUDE_CONFIG_DIR adds "-" plus the first
 * 8 hex characters of the SHA-256 of that folder path (NFC-normalised).
 */
export function claudeKeychainService(configDir: string | null): string {
  if (!configDir) return 'Claude Code-credentials';
  const hash = createHash('sha256').update(configDir.normalize('NFC')).digest('hex').slice(0, 8);
  return `Claude Code-credentials-${hash}`;
}

export function keychainAccount(): string {
  const name = process.env.USER || userInfo().username;
  return /^[a-zA-Z0-9._-]+$/.test(name) ? name : 'claude-code-user';
}

export interface ClaudeOauth {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
  subscriptionType?: string;
  rateLimitTier?: string;
  scopes?: string[];
}

export interface ClaudeCredentials {
  claudeAiOauth?: ClaudeOauth;
  [key: string]: unknown;
}

function run(cmd: string, args: string[], input?: string): Promise<{ code: number; out: string; err: string }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('close', (code) => resolve({ code: code ?? 1, out, err }));
    child.on('error', (e) => resolve({ code: 1, out, err: String(e) }));
    if (input !== undefined) child.stdin.end(input);
    else child.stdin.end();
  });
}

export async function readGenericPassword(service: string, account = keychainAccount()): Promise<string | null> {
  if (process.platform !== 'darwin') return null;
  const r = await run('security', ['find-generic-password', '-s', service, '-a', account, '-w']);
  return r.code === 0 ? r.out.replace(/\n$/, '') : null;
}

/**
 * Store a secret without putting it on the command line (where `ps` could see it):
 * `security -i` reads its commands from stdin.
 */
export async function writeGenericPassword(service: string, secret: string, account = keychainAccount()): Promise<boolean> {
  if (process.platform !== 'darwin') return false;
  const q = (s: string) => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  const hex = Buffer.from(secret, 'utf8').toString('hex');
  const r = await run('security', ['-i'], `add-generic-password -U -s ${q(service)} -a ${q(account)} -X ${hex}\n`);
  return r.code === 0 && !/error/i.test(r.err);
}

export async function deleteGenericPassword(service: string, account = keychainAccount()): Promise<void> {
  if (process.platform !== 'darwin') return;
  await run('security', ['delete-generic-password', '-s', service, '-a', account]);
}

export async function readClaudeCredentials(configDir: string | null): Promise<ClaudeCredentials | null> {
  // Linux and Windows: Claude Code keeps the login in .credentials.json inside the config folder.
  if (process.platform !== 'darwin') {
    try {
      return JSON.parse(readFileSync(join(configDir ?? join(homedir(), '.claude'), '.credentials.json'), 'utf8')) as ClaudeCredentials;
    } catch {
      return null;
    }
  }
  const raw = await readGenericPassword(claudeKeychainService(configDir));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as ClaudeCredentials;
  } catch {
    return null;
  }
}

export async function writeClaudeCredentials(configDir: string | null, creds: ClaudeCredentials): Promise<boolean> {
  return writeGenericPassword(claudeKeychainService(configDir), JSON.stringify(creds));
}

/** The API key used for the paid fallback lives in its own Keychain item. */
export const API_KEY_SERVICE = 'multiclaude-api-key';

/** MC_API_KEY, when set, takes the place of the Keychain item (handy for tests and CI). */
export function readApiKey(): Promise<string | null> {
  if (process.env.MC_API_KEY) return Promise.resolve(process.env.MC_API_KEY);
  return readGenericPassword(API_KEY_SERVICE);
}
export function saveApiKey(key: string): Promise<boolean> {
  return writeGenericPassword(API_KEY_SERVICE, key);
}
export function deleteApiKey(): Promise<void> {
  return deleteGenericPassword(API_KEY_SERVICE);
}
