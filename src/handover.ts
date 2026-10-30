import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { HANDOVER_DIR } from './paths.ts';
import { findSession } from './sessions.ts';
import { logActivity } from './util.ts';

/**
 * A handover note is built from the session file alone, with no AI call: the goal,
 * recent requests, files changed, open todos and Claude's last reply. A new session on
 * another account reads it and picks up where the old one stopped, without carrying
 * the whole old context.
 */

interface Block {
  type: string;
  text?: string;
  name?: string;
  input?: Record<string, unknown>;
}

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

function textOf(content: unknown): string | null {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return null;
  if (content.some((b: Block) => b?.type === 'tool_result')) return null;
  const t = content.filter((b: Block) => b?.type === 'text').map((b: Block) => b.text ?? '').join('\n');
  return t || null;
}

function isHumanPrompt(t: string): boolean {
  const s = t.trim();
  return Boolean(s) && !s.startsWith('<') && !s.startsWith('Caveat:') && !s.startsWith('[Request interrupted');
}

function clip(s: string, n: number): string {
  const one = s.replace(/\s+\n/g, '\n').trim();
  return one.length > n ? `${one.slice(0, n - 1)}…` : one;
}

export interface Handover {
  sessionId: string;
  title?: string;
  cwd?: string;
  branch?: string;
  goal?: string;
  recent: string[];
  files: string[];
  todos: { content: string; status: string }[];
  lastReply?: string;
}

export function buildHandover(sessionId: string): Handover {
  const file = findSession(sessionId);
  if (!file) throw new Error(`No session found with id ${sessionId}`);
  const h: Handover = { sessionId, recent: [], files: [], todos: [] };
  const prompts: string[] = [];
  const files = new Set<string>();
  const tasks = new Map<string, { content: string; status: string }>();

  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line.startsWith('{')) continue;
    let d: Record<string, unknown>;
    try {
      d = JSON.parse(line);
    } catch {
      continue;
    }
    h.cwd ??= d.cwd as string | undefined;
    if (d.gitBranch) h.branch = String(d.gitBranch);
    if (d.type === 'ai-title' && d.aiTitle && !h.title) h.title = String(d.aiTitle);
    if (d.type === 'custom-title' && d.customTitle) h.title = String(d.customTitle);
    if (d.isSidechain) continue;
    const msg = d.message as { content?: unknown } | undefined;

    if (d.type === 'user' && !d.isMeta) {
      const t = textOf(msg?.content);
      if (t && isHumanPrompt(t)) prompts.push(t);
    }
    if (d.type === 'assistant' && Array.isArray(msg?.content)) {
      for (const b of msg.content as Block[]) {
        if (b.type === 'text' && b.text?.trim()) h.lastReply = b.text;
        if (b.type !== 'tool_use' || !b.input) continue;
        if (EDIT_TOOLS.has(b.name ?? '')) {
          const p = (b.input.file_path ?? b.input.notebook_path) as string | undefined;
          if (p) files.add(p);
        }
        if (b.name === 'TodoWrite' && Array.isArray(b.input.todos)) {
          tasks.clear();
          (b.input.todos as { content: string; status: string }[]).forEach((t, i) => tasks.set(String(i), { content: t.content, status: t.status }));
        }
        if (b.name === 'TaskCreate' && b.input.subject) {
          tasks.set(`task-${tasks.size + 1}`, { content: String(b.input.subject), status: 'pending' });
        }
        if (b.name === 'TaskUpdate' && b.input.taskId && b.input.status) {
          const t = tasks.get(`task-${b.input.taskId}`);
          if (t) t.status = String(b.input.status);
        }
      }
    }
  }
  h.goal = prompts[0];
  h.recent = prompts.slice(1).slice(-6);
  h.files = [...files].slice(-30);
  h.todos = [...tasks.values()];
  return h;
}

export function handoverMarkdown(h: Handover, fromProfile: string, toProfile: string): string {
  const out: string[] = [];
  out.push(`# Handover: ${h.title ?? 'session'}`);
  out.push('');
  out.push(`Moved from the **${fromProfile}** account to **${toProfile}** on ${new Date().toLocaleString()}.`);
  out.push(`Original session: \`${h.sessionId}\`${h.cwd ? ` in \`${h.cwd}\`` : ''}${h.branch && h.branch !== 'HEAD' ? ` on branch \`${h.branch}\`` : ''}.`);
  out.push('');
  if (h.goal) out.push('## What the session set out to do', '', clip(h.goal, 1500), '');
  if (h.recent.length) {
    out.push('## Latest requests (oldest first)', '');
    for (const p of h.recent) out.push(`- ${clip(p, 400).replace(/\n/g, ' ')}`);
    out.push('');
  }
  if (h.todos.length) {
    out.push('## Todo list at handover', '');
    for (const t of h.todos) out.push(`- [${t.status === 'completed' ? 'x' : ' '}] ${t.content}${t.status === 'in_progress' ? ' (in progress)' : ''}`);
    out.push('');
  }
  if (h.files.length) {
    out.push('## Files changed', '');
    for (const f of h.files) out.push(`- ${f}`);
    out.push('');
  }
  if (h.lastReply) out.push("## Claude's last reply", '', clip(h.lastReply, 2500), '');
  out.push('## How to continue', '');
  out.push('Check the current state of the files above (run `git status` / `git diff` if this is a repo), then carry on with the open work. The full old transcript is at the session id above if you need detail.');
  return out.join('\n') + '\n';
}

/** Write the note to ~/.multiclaude/handovers and return its path. */
export function writeHandover(sessionId: string, fromProfile: string, toProfile: string): { path: string; handover: Handover } {
  const h = buildHandover(sessionId);
  mkdirSync(HANDOVER_DIR, { recursive: true, mode: 0o700 });
  const path = join(HANDOVER_DIR, `${new Date().toISOString().replace(/[:.]/g, '-')}-${sessionId.slice(0, 8)}.md`);
  writeFileSync(path, handoverMarkdown(h, fromProfile, toProfile), { mode: 0o600 });
  logActivity('handover', `Handover note for "${h.title ?? sessionId.slice(0, 8)}" from ${fromProfile} to ${toProfile}`, toProfile);
  return { path, handover: h };
}

export function handoverPrompt(path: string): string {
  return `I'm continuing work from another session. Read the handover note at ${path}, check the current state of the files it lists, then tell me in two or three lines where things stand and carry on with the open work.`;
}
