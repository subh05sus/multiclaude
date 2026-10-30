import { createReadStream, existsSync, openSync, readSync, closeSync, readdirSync, statSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { join, basename } from 'node:path';
import { MAIN_CLAUDE_DIR, SESSION_MAP_FILE, STATS_CACHE_FILE, MAIN_PROFILE } from './paths.ts';
import { appendJsonLine, readJson, readJsonLines, writeJson } from './util.ts';
import { costUsd, type TokenUsage } from './pricing.ts';

const PROJECTS = () => join(MAIN_CLAUDE_DIR, 'projects');

/** One line per session start or resume, written by the SessionStart hook. */
export interface SessionMark {
  at: string;
  sessionId: string;
  profile: string;
  cwd?: string;
  source?: string;
}

export function recordSessionStart(m: SessionMark): void {
  appendJsonLine(SESSION_MAP_FILE, m);
}

export function readSessionMarks(): Map<string, SessionMark[]> {
  const map = new Map<string, SessionMark[]>();
  for (const m of readJsonLines<SessionMark>(SESSION_MAP_FILE)) {
    if (!m.sessionId) continue;
    const list = map.get(m.sessionId) ?? [];
    list.push(m);
    map.set(m.sessionId, list);
  }
  for (const list of map.values()) list.sort((a, b) => a.at.localeCompare(b.at));
  return map;
}

/** Which profile ran a session at a given moment. */
export function profileAt(marks: SessionMark[] | undefined, at: string, fallback = MAIN_PROFILE): string {
  if (!marks?.length) return fallback;
  let p = marks[0].profile;
  for (const m of marks) if (m.at <= at) p = m.profile;
  return p;
}

function readSlice(file: string, start: number, length: number): string {
  const fd = openSync(file, 'r');
  try {
    const buf = Buffer.alloc(length);
    const n = readSync(fd, buf, 0, length, start);
    return buf.subarray(0, n).toString('utf8');
  } finally {
    closeSync(fd);
  }
}

function lines(text: string): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const l of text.split('\n')) {
    if (!l.startsWith('{')) continue;
    try {
      out.push(JSON.parse(l));
    } catch {
      /* cut-off line at a slice edge */
    }
  }
  return out;
}

function promptText(msg: unknown): string | null {
  const m = msg as { content?: unknown } | undefined;
  const c = m?.content;
  let text: string | null = null;
  if (typeof c === 'string') text = c;
  else if (Array.isArray(c)) {
    if (c.some((b) => b?.type === 'tool_result')) return null;
    text = c.filter((b) => b?.type === 'text').map((b) => b.text).join('\n') || null;
  }
  if (!text) return null;
  const t = text.trim();
  if (!t || t.startsWith('<') || t.startsWith('Caveat:')) return null;
  return t;
}

export interface SessionSummary {
  id: string;
  file: string;
  project: string;
  cwd?: string;
  branch?: string;
  title: string;
  updatedAt: string;
  sizeBytes: number;
  profile: string;
  ownerAccount?: string;
}

/** Recent sessions across every project, newest first. Reads only the start and end of each file. */
export function listSessions(limit = 50, accountMap = new Map<string, string>()): SessionSummary[] {
  const root = PROJECTS();
  if (!existsSync(root)) return [];
  const files: { file: string; project: string; mtime: number; size: number }[] = [];
  for (const proj of readdirSync(root)) {
    const dir = join(root, proj);
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const f of entries) {
      if (!f.endsWith('.jsonl')) continue;
      const file = join(dir, f);
      try {
        const st = statSync(file);
        files.push({ file, project: proj, mtime: st.mtimeMs, size: st.size });
      } catch {
        /* removed meanwhile */
      }
    }
  }
  files.sort((a, b) => b.mtime - a.mtime);
  const marks = readSessionMarks();
  const out: SessionSummary[] = [];
  for (const f of files.slice(0, limit)) {
    const head = lines(readSlice(f.file, 0, Math.min(f.size, 200_000)));
    const tail = f.size > 200_000 ? lines(readSlice(f.file, Math.max(0, f.size - 300_000), 300_000)) : head;
    const id = basename(f.file, '.jsonl');
    let cwd: string | undefined;
    let branch: string | undefined;
    let first: string | null = null;
    let title: string | undefined;
    let customTitle: string | undefined;
    let owner: string | undefined;
    let updatedAt = new Date(f.mtime).toISOString();
    for (const l of head) {
      cwd ??= l.cwd as string | undefined;
      branch ??= l.gitBranch as string | undefined;
      if (!first && l.type === 'user' && !l.isMeta) first = promptText(l.message);
      if (l.type === 'bridge-session') owner ??= l.ownerAccountUuid as string;
    }
    for (const l of tail) {
      if (l.type === 'custom-title' && l.customTitle) customTitle = String(l.customTitle);
      else if (l.type === 'ai-title' && l.aiTitle) title = String(l.aiTitle);
      if (typeof l.timestamp === 'string') updatedAt = l.timestamp;
      if (l.gitBranch) branch = String(l.gitBranch);
      if (l.type === 'bridge-session') owner = l.ownerAccountUuid as string;
    }
    const mk = marks.get(id);
    const fallback = (owner && accountMap.get(owner)) || MAIN_PROFILE;
    out.push({
      id,
      file: f.file,
      project: f.project,
      cwd,
      branch,
      title: customTitle || title || (first ? first.slice(0, 90) : 'Untitled session'),
      updatedAt,
      sizeBytes: f.size,
      profile: mk?.length ? mk[mk.length - 1].profile : fallback,
      ownerAccount: owner,
    });
  }
  return out;
}

export function findSession(id: string): string | null {
  const root = PROJECTS();
  if (!existsSync(root) || !/^[\w-]+$/.test(id)) return null;
  for (const proj of readdirSync(root)) {
    const file = join(root, proj, `${id}.jsonl`);
    if (existsSync(file)) return file;
  }
  return null;
}

// ---------------------------------------------------------------- stats

interface Bucket {
  in: number;
  out: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  msgs: number;
}

interface FileStats {
  size: number;
  offset: number;
  sessionId: string;
  cwd?: string;
  owner?: string;
  lastMsgId?: string;
  /** Key: "YYYY-MM-DDTHH|model" */
  buckets: Record<string, Bucket>;
}

interface StatsCache {
  version: 2;
  files: Record<string, FileStats>;
}

function allTranscripts(): string[] {
  const root = PROJECTS();
  if (!existsSync(root)) return [];
  const out: string[] = [];
  const walk = (dir: string, depth: number) => {
    let entries: import('node:fs').Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory() && depth < 3) walk(p, depth + 1);
      else if (e.isFile() && e.name.endsWith('.jsonl')) out.push(p);
    }
  };
  walk(root, 0);
  return out;
}

function sessionIdFor(file: string): string {
  // Subagent transcripts live in <project>/<session-id>/subagents/agent-*.jsonl.
  const m = /[\\/]([0-9a-f-]{36})[\\/]subagents[\\/]/.exec(file);
  return m ? m[1] : basename(file, '.jsonl');
}

async function scanFile(file: string, prev: FileStats | undefined): Promise<FileStats> {
  const st = statSync(file);
  const fresh = !prev || st.size < prev.offset;
  const fs: FileStats = fresh
    ? { size: st.size, offset: 0, sessionId: sessionIdFor(file), buckets: {} }
    : { ...prev, size: st.size, buckets: { ...prev.buckets } };
  if (!fresh && st.size === prev.offset) return fs;

  const rl = createInterface({ input: createReadStream(file, { start: fs.offset, encoding: 'utf8' }), crlfDelay: Infinity });
  let consumed = fs.offset;
  let lastStart = fs.offset;
  for await (const line of rl) {
    lastStart = consumed;
    consumed += Buffer.byteLength(line, 'utf8') + 1;
    if (!fs.cwd && line.includes('"cwd":"')) fs.cwd = /"cwd":"((?:[^"\\]|\\.)*)"/.exec(line)?.[1];
    if (!fs.owner && line.includes('"bridge-session"')) fs.owner = /"ownerAccountUuid":"([^"]+)"/.exec(line)?.[1];
    if (!line.includes('"type":"assistant"') || !line.includes('"usage"')) continue;
    let d: { timestamp?: string; message?: { id?: string; model?: string; usage?: TokenUsage } };
    try {
      d = JSON.parse(line);
    } catch {
      continue;
    }
    const msg = d.message;
    if (!msg?.usage || !msg.model || msg.model === '<synthetic>' || !d.timestamp) continue;
    // Claude Code writes one line per content block, all carrying the same usage.
    if (msg.id && msg.id === fs.lastMsgId) continue;
    fs.lastMsgId = msg.id;
    const key = `${d.timestamp.slice(0, 13)}|${msg.model}`;
    const b = (fs.buckets[key] ??= { in: 0, out: 0, cacheRead: 0, cacheWrite: 0, cost: 0, msgs: 0 });
    const u = msg.usage;
    b.in += u.input_tokens ?? 0;
    b.out += u.output_tokens ?? 0;
    b.cacheRead += u.cache_read_input_tokens ?? 0;
    b.cacheWrite += u.cache_creation_input_tokens ?? 0;
    b.cost += costUsd(msg.model, u);
    b.msgs += 1;
  }
  // If the file doesn't end in a newline, its last line is still being written: read it next time.
  const endsClean = st.size === 0 || readSlice(file, st.size - 1, 1) === '\n';
  fs.offset = endsClean ? Math.min(consumed, st.size) : lastStart;
  return fs;
}

let scanning: Promise<StatsCache> | null = null;

/** Bring the stats cache up to date. Only the new part of each file is read. */
export function refreshStats(): Promise<StatsCache> {
  if (scanning) return scanning;
  scanning = (async () => {
    const cache = readJson<StatsCache>(STATS_CACHE_FILE, { version: 2, files: {} });
    if (cache.version !== 2) cache.files = {};
    const next: StatsCache = { version: 2, files: {} };
    for (const file of allTranscripts()) {
      try {
        next.files[file] = await scanFile(file, cache.files[file]);
      } catch {
        if (cache.files[file]) next.files[file] = cache.files[file];
      }
    }
    writeJson(STATS_CACHE_FILE, next);
    return next;
  })().finally(() => {
    scanning = null;
  });
  return scanning;
}

export interface StatsRow {
  key: string;
  cost: number;
  tokens: number;
  msgs: number;
}

export interface StatsReport {
  rangeDays: number;
  totals: { cost: number; tokens: number; msgs: number; sessions: number };
  days: { day: string; cost: number; tokens: number; byProfile: Record<string, number> }[];
  byProfile: StatsRow[];
  byModel: StatsRow[];
  byProject: StatsRow[];
}

function localDay(hourKey: string): string {
  const d = new Date(`${hourKey}:00:00Z`);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function projectName(cwd: string | undefined, file: string): string {
  if (cwd) return cwd.replace(/\\\\/g, '\\').split('/').filter(Boolean).slice(-1)[0] ?? cwd;
  return basename(join(file, '..'));
}

export async function statsReport(rangeDays = 30, accountMap = new Map<string, string>()): Promise<StatsReport> {
  const cache = await refreshStats();
  const marks = readSessionMarks();
  const since = new Date(Date.now() - rangeDays * 86400_000).toISOString().slice(0, 13);
  const days = new Map<string, { cost: number; tokens: number; byProfile: Record<string, number> }>();
  const groups = { byProfile: new Map<string, StatsRow>(), byModel: new Map<string, StatsRow>(), byProject: new Map<string, StatsRow>() };
  const sessions = new Set<string>();
  const totals = { cost: 0, tokens: 0, msgs: 0, sessions: 0 };
  const add = (m: Map<string, StatsRow>, key: string, b: Bucket, tokens: number) => {
    const r = m.get(key) ?? { key, cost: 0, tokens: 0, msgs: 0 };
    r.cost += b.cost;
    r.tokens += tokens;
    r.msgs += b.msgs;
    m.set(key, r);
  };
  for (const [file, fs] of Object.entries(cache.files)) {
    const fallback = (fs.owner && accountMap.get(fs.owner)) || MAIN_PROFILE;
    const proj = projectName(fs.cwd, file);
    for (const [key, b] of Object.entries(fs.buckets)) {
      const [hour, model] = key.split('|');
      if (hour < since) continue;
      const profile = profileAt(marks.get(fs.sessionId), `${hour}:59:59`, fallback);
      const tokens = b.in + b.out + b.cacheRead + b.cacheWrite;
      const day = localDay(hour);
      const d = days.get(day) ?? { cost: 0, tokens: 0, byProfile: {} };
      d.cost += b.cost;
      d.tokens += tokens;
      d.byProfile[profile] = (d.byProfile[profile] ?? 0) + b.cost;
      days.set(day, d);
      add(groups.byProfile, profile, b, tokens);
      add(groups.byModel, model, b, tokens);
      add(groups.byProject, proj, b, tokens);
      totals.cost += b.cost;
      totals.tokens += tokens;
      totals.msgs += b.msgs;
      sessions.add(fs.sessionId);
    }
  }
  totals.sessions = sessions.size;
  const sorted = (m: Map<string, StatsRow>) => [...m.values()].sort((a, b) => b.cost - a.cost);
  const dayList: StatsReport['days'] = [];
  for (let i = rangeDays - 1; i >= 0; i--) {
    const day = localDay(new Date(Date.now() - i * 86400_000).toISOString().slice(0, 13));
    dayList.push({ day, ...(days.get(day) ?? { cost: 0, tokens: 0, byProfile: {} }) });
  }
  return { rangeDays, totals, days: dayList, byProfile: sorted(groups.byProfile), byModel: sorted(groups.byModel), byProject: sorted(groups.byProject).slice(0, 12) };
}
