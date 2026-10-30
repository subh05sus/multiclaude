import { readFileSync, writeFileSync, renameSync, mkdirSync, appendFileSync, existsSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { ACTIVITY_FILE, SECRET_FILE, MC_DIR } from './paths.ts';

export function readJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as T;
  } catch {
    return fallback;
  }
}

/** Write JSON through a temp file and rename, so readers never see half a file. */
export function writeJson(file: string, data: unknown, mode = 0o600): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', { mode });
  renameSync(tmp, file);
}

export function readJsonLines<T>(file: string): T[] {
  if (!existsSync(file)) return [];
  const out: T[] = [];
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as T);
    } catch {
      /* skip a torn line */
    }
  }
  return out;
}

export function appendJsonLine(file: string, data: unknown): void {
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, JSON.stringify(data) + '\n', { mode: 0o600 });
}

export type ActivityKind =
  | 'launch' | 'switch' | 'fallback-on' | 'fallback-off' | 'fallback-cap' | 'alert' | 'reset'
  | 'profile-added' | 'profile-removed' | 'handover' | 'heal' | 'error' | 'settings' | 'import';

export interface Activity {
  at: string;
  kind: ActivityKind;
  profile?: string;
  text: string;
}

export function logActivity(kind: ActivityKind, text: string, profile?: string): void {
  try {
    appendJsonLine(ACTIVITY_FILE, { at: new Date().toISOString(), kind, profile, text } satisfies Activity);
  } catch {
    /* activity is best effort */
  }
}

/** A random secret shared by the daemon, the dashboard and the menu bar app. */
export function getSecret(): string {
  try {
    const s = readFileSync(SECRET_FILE, 'utf8').trim();
    if (s.length >= 32) return s;
  } catch {
    /* create below */
  }
  mkdirSync(MC_DIR, { recursive: true, mode: 0o700 });
  const s = randomBytes(24).toString('hex');
  writeFileSync(SECRET_FILE, s + '\n', { mode: 0o600 });
  chmodSync(SECRET_FILE, 0o600);
  return s;
}

/**
 * Show a desktop notification. Text goes in as arguments, never into the script.
 * Never during tests (Node's test runner sets NODE_TEST_CONTEXT) or with MC_NO_NOTIFY set.
 */
export function notify(title: string, body: string): void {
  if (process.env.NODE_TEST_CONTEXT || process.env.MC_NO_NOTIFY) return;
  if (process.platform === 'linux') return void execFile('notify-send', [title, body], () => {});
  if (process.platform === 'win32') {
    // A Windows toast through PowerShell's built-in WinRT access; text arrives as environment variables.
    const ps = [
      '[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] > $null',
      '$x = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)',
      '$t = $x.GetElementsByTagName("text")',
      '$t.Item(0).AppendChild($x.CreateTextNode($env:MC_TITLE)) > $null',
      '$t.Item(1).AppendChild($x.CreateTextNode($env:MC_BODY)) > $null',
      '$app = "{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe"',
      '[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($app).Show([Windows.UI.Notifications.ToastNotification]::new($x))',
    ].join('; ');
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', ps], { env: { ...process.env, MC_TITLE: title, MC_BODY: body }, windowsHide: true }, () => {});
    return;
  }
  if (process.platform !== 'darwin') return;
  const script = 'on run argv\ndisplay notification (item 2 of argv) with title (item 1 of argv)\nend run';
  execFile('osascript', ['-e', script, title, body], () => {});
}

export function shellQuote(s: string): string {
  if (/^[\w@%+=:,./-]+$/.test(s)) return s;
  return `'${s.replace(/'/g, `'\\''`)}'`;
}


export function fmtPct(n: number | undefined | null): string {
  return n == null || Number.isNaN(n) ? '—' : `${Math.round(n)}%`;
}

export function today(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function isValidProfileName(name: string): boolean {
  return /^[a-z0-9][a-z0-9_-]{0,31}$/.test(name);
}
