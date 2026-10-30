import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { HOME, MC_BIN } from './paths.ts';
import { logActivity } from './util.ts';

/**
 * Optional: make the plain `claude` command go through multiclaude, so it starts on the
 * account `mc auto` would pick. It's a small shell function in your shell's startup file,
 * between marker lines, so it can be removed cleanly. `command claude` skips it.
 */

const START = '# >>> multiclaude: `claude` picks an account (remove with: mc shell off) >>>';
const END = '# <<< multiclaude <<<';

function posixBlock(): string {
  return `${START}
claude() { "${MC_BIN}" claude "$@"; }
${END}`;
}

const FISH_FILE = join(HOME, '.config', 'fish', 'functions', 'claude.fish');
function fishBody(): string {
  return `${START}
function claude --wraps claude --description 'Claude Code through multiclaude'
    "${MC_BIN}" claude $argv
end
${END}
`;
}

/** Startup files for the user's shell (and zsh/bash ones that already exist). */
function rcFiles(): string[] {
  const shell = process.env.SHELL ?? '';
  const files = new Set<string>();
  if (shell.endsWith('zsh') || existsSync(join(HOME, '.zshrc'))) files.add(join(HOME, '.zshrc'));
  if (shell.endsWith('bash') || existsSync(join(HOME, '.bashrc'))) files.add(join(HOME, '.bashrc'));
  // macOS Terminal opens bash as a login shell, which reads .bash_profile, not .bashrc.
  if (shell.endsWith('bash') && process.platform === 'darwin') files.add(join(HOME, '.bash_profile'));
  return [...files];
}

function strip(text: string): string {
  const re = new RegExp(`\\n?${START.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[\\s\\S]*?${END.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\n?`, 'g');
  return text.replace(re, '\n');
}

export interface ShellStatus {
  installed: string[];
  shell: string;
}

export function shellStatus(): ShellStatus {
  const installed = rcFiles().filter((f) => existsSync(f) && readFileSync(f, 'utf8').includes(START));
  if (existsSync(FISH_FILE) && readFileSync(FISH_FILE, 'utf8').includes(START)) installed.push(FISH_FILE);
  return { installed, shell: process.env.SHELL ?? 'unknown' };
}

export function installShell(): string[] {
  const done: string[] = [];
  for (const f of rcFiles()) {
    const before = existsSync(f) ? readFileSync(f, 'utf8') : '';
    const next = `${strip(before).replace(/\n*$/, '\n')}\n${posixBlock()}\n`;
    if (next === before) continue;
    if (before) copyFileSync(f, `${f}.mc-backup`);
    writeFileSync(f, next);
    done.push(f);
  }
  if ((process.env.SHELL ?? '').endsWith('fish') || existsSync(join(HOME, '.config', 'fish'))) {
    mkdirSync(join(HOME, '.config', 'fish', 'functions'), { recursive: true });
    if (!existsSync(FISH_FILE) || readFileSync(FISH_FILE, 'utf8').includes(START)) {
      writeFileSync(FISH_FILE, fishBody());
      done.push(FISH_FILE);
    }
  }
  if (done.length) logActivity('settings', '`claude` now picks an account through multiclaude');
  return done;
}

export function uninstallShell(): string[] {
  const done: string[] = [];
  for (const f of rcFiles()) {
    if (!existsSync(f)) continue;
    const before = readFileSync(f, 'utf8');
    if (!before.includes(START)) continue;
    writeFileSync(f, strip(before).replace(/\n{3,}/g, '\n\n'));
    done.push(f);
  }
  if (existsSync(FISH_FILE) && readFileSync(FISH_FILE, 'utf8').includes(START)) {
    rmSync(FISH_FILE);
    done.push(FISH_FILE);
  }
  if (done.length) logActivity('settings', '`claude` is plain Claude Code again');
  return done;
}

/**
 * Commands that manage Claude Code itself rather than start a chat. They run unchanged on
 * your main setup, so `claude mcp add` still lands in ~/.claude.json (which every profile
 * copies from) and `claude update` updates the one install.
 */
const PASS_THROUGH = new Set([
  'mcp', 'update', 'upgrade', 'install', 'doctor', 'plugin', 'plugins', 'auth', 'setup-token', 'config', 'migrate-installer',
  'import', 'purge', 'gateway', 'auto-mode', 'agents', 'attach', 'logs', 'stop', 'kill', 'rm', 'respawn', 'ultrareview',
  '-v', '--version', '-h', '--help',
]);

export type ClaudeRoute = { kind: 'plain'; why: string } | { kind: 'pick' };

/** Decide whether a `claude …` call should pick an account or run as plain Claude Code. */
export function routeClaude(args: string[], env: NodeJS.ProcessEnv = process.env): ClaudeRoute {
  if (env.MC_BYPASS) return { kind: 'plain', why: 'MC_BYPASS is set' };
  // Already inside a multiclaude session (for example a nested `claude -p` from a tool call):
  // stay on that account rather than picking again.
  if (env.MC_PROFILE) return { kind: 'plain', why: 'inside a multiclaude session' };
  if (env.CLAUDE_CONFIG_DIR) return { kind: 'plain', why: 'CLAUDE_CONFIG_DIR is set' };
  if (env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN || env.CLAUDE_CODE_USE_BEDROCK || env.CLAUDE_CODE_USE_VERTEX) {
    return { kind: 'plain', why: 'an API key or cloud provider is set' };
  }
  const first = args[0];
  if (first && PASS_THROUGH.has(first)) return { kind: 'plain', why: `"${first}" manages Claude Code itself` };
  return { kind: 'pick' };
}
