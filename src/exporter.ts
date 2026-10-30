import { readFileSync, writeFileSync } from 'node:fs';
import { scryptSync, randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import { loadConfig, saveConfig, type Config } from './config.ts';
import { claudeJsonPath, configDirEnv, createProfileDir, isMain, type OauthAccount } from './profiles.ts';
import { readClaudeCredentials, writeClaudeCredentials, readApiKey, saveApiKey, type ClaudeCredentials } from './keychain.ts';
import { readJson, writeJson, logActivity } from './util.ts';

/**
 * File layout: "MCX1" | salt (16) | iv (12) | auth tag (16) | AES-256-GCM ciphertext.
 * The key comes from your passphrase through scrypt.
 */
const MAGIC = Buffer.from('MCX1');

interface Payload {
  version: 1;
  exportedAt: string;
  config: Config;
  accounts: Record<string, OauthAccount | undefined>;
  logins?: Record<string, ClaudeCredentials>;
  apiKey?: string;
}

function key(pass: string, salt: Buffer): Buffer {
  return scryptSync(pass, salt, 32, { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
}

export async function exportBundle(file: string, pass: string, withLogins: boolean): Promise<{ profiles: number; logins: number }> {
  const config = loadConfig();
  const payload: Payload = { version: 1, exportedAt: new Date().toISOString(), config, accounts: {} };
  for (const p of config.profiles) payload.accounts[p.name] = readJson<{ oauthAccount?: OauthAccount }>(claudeJsonPath(p.name), {}).oauthAccount;
  let logins = 0;
  if (withLogins) {
    payload.logins = {};
    for (const p of config.profiles) {
      const c = await readClaudeCredentials(configDirEnv(p.name));
      if (c) {
        payload.logins[p.name] = c;
        logins++;
      }
    }
    payload.apiKey = (await readApiKey()) ?? undefined;
  }
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key(pass, salt), iv);
  const enc = Buffer.concat([cipher.update(JSON.stringify(payload), 'utf8'), cipher.final()]);
  writeFileSync(file, Buffer.concat([MAGIC, salt, iv, cipher.getAuthTag(), enc]), { mode: 0o600 });
  return { profiles: config.profiles.length, logins };
}

export async function importBundle(file: string, pass: string, overwriteLogins: boolean): Promise<string[]> {
  const buf = readFileSync(file);
  if (!buf.subarray(0, 4).equals(MAGIC)) throw new Error('Not a multiclaude export file.');
  const salt = buf.subarray(4, 20);
  const iv = buf.subarray(20, 32);
  const tag = buf.subarray(32, 48);
  const decipher = createDecipheriv('aes-256-gcm', key(pass, salt), iv);
  decipher.setAuthTag(tag);
  let payload: Payload;
  try {
    payload = JSON.parse(Buffer.concat([decipher.update(buf.subarray(48)), decipher.final()]).toString('utf8'));
  } catch {
    throw new Error('Wrong passphrase, or the file is damaged.');
  }

  const notes: string[] = [];
  const cfg = loadConfig();
  const merged: Config = { ...payload.config, port: cfg.port, claudePath: cfg.claudePath, statuslineWrap: cfg.statuslineWrap };
  saveConfig(merged);
  for (const p of merged.profiles) {
    if (!isMain(p.name)) createProfileDir(p.name);
    const acct = payload.accounts[p.name];
    if (acct && !isMain(p.name)) {
      const j = readJson<Record<string, unknown>>(claudeJsonPath(p.name), {});
      j.oauthAccount ??= acct;
      writeJson(claudeJsonPath(p.name), j);
    }
    const login = payload.logins?.[p.name];
    if (login) {
      const existing = await readClaudeCredentials(configDirEnv(p.name));
      if (existing && !overwriteLogins) notes.push(`${p.name}: kept the login already on this Mac`);
      else if (await writeClaudeCredentials(configDirEnv(p.name), login)) notes.push(`${p.name}: login imported`);
      else notes.push(`${p.name}: could not write the login to the Keychain`);
    } else notes.push(`${p.name}: set up (sign in with "mc ${p.name} auth login")`);
  }
  if (payload.apiKey && (overwriteLogins || !(await readApiKey()))) {
    await saveApiKey(payload.apiKey);
    notes.push('API key imported');
  }
  logActivity('import', `Imported ${merged.profiles.length} profiles from ${file}`);
  return notes;
}
