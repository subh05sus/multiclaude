import { execFile } from 'node:child_process';
import { loadConfig } from './config.ts';
import { ensureDaemon, launch } from './launch.ts';
import { readState, type AppState, type ProfileState } from './state.ts';
import { getSecret } from './util.ts';
import type { UsageWindow } from './usage.ts';

const ESC = '\x1b[';
const b = (s: string) => `${ESC}1m${s}${ESC}0m`;
const dim = (s: string) => `${ESC}2m${s}${ESC}0m`;
const color = (pct: number, s: string) => `${ESC}${pct >= 90 ? '31' : pct >= 70 ? '33' : '32'}m${s}${ESC}0m`;

function bar(w: UsageWindow | undefined, width = 10): string {
  if (!w) return dim('░'.repeat(width) + '   —');
  const filled = Math.round((Math.min(100, w.pct) / 100) * width);
  return color(w.pct, '█'.repeat(filled)) + dim('░'.repeat(width - filled)) + ' ' + color(w.pct, `${String(Math.round(w.pct)).padStart(3)}%`);
}

function resetIn(ms?: number): string {
  if (!ms) return '';
  const m = Math.max(0, Math.round((ms - Date.now()) / 60000));
  return m >= 60 * 24 ? `${Math.round(m / 1440)}d` : m >= 60 ? `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}` : `${m}m`;
}

function row(p: ProfileState, selected: boolean, nextName: string | null): string {
  const name = p.name.padEnd(12);
  const plan = (p.info.plan ?? '').padEnd(8);
  let tail: string;
  if (!p.info.loggedIn) tail = dim('signed out — press ↵ to sign in');
  else {
    tail = `${dim('5h')} ${bar(p.usage.fiveHour)} ${dim(resetIn(p.usage.fiveHour?.resetsAt).padStart(5))}   ${dim('wk')} ${bar(p.usage.sevenDay)}`;
  }
  const tags: string[] = [];
  if (p.paused) tags.push(dim('paused'));
  else if (p.peak !== undefined && p.peak >= p.switchAt) tags.push(`${ESC}31mfull${ESC}0m`);
  if (p.fallback.active) tags.push(`${ESC}35mon API key${ESC}0m`);
  if (p.name === nextName) tags.push(`${ESC}36m★ pick${ESC}0m`);
  const cursor = selected ? `${ESC}36m❯${ESC}0m` : ' ';
  const label = selected ? b(name) : name;
  return ` ${cursor} ${dim(String(p.position))} ${label} ${dim(plan)} ${tail}  ${tags.join(' ')}`;
}

async function api(port: number, path: string, body?: unknown): Promise<AppState | null> {
  try {
    const r = await fetch(`http://127.0.0.1:${port}${path}`, body === undefined ? { signal: AbortSignal.timeout(4000) } : {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-mc-token': getSecret() },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15000),
    });
    return r.ok ? ((await r.json()) as AppState) : null;
  } catch {
    return null;
  }
}

export async function pickerTui(extraArgs: string[]): Promise<void> {
  const cfg = loadConfig();
  await ensureDaemon(cfg);
  let state = (await api(cfg.port, '/api/state')) ?? readState();
  if (!state) {
    console.error('Could not read account state. Try "mc doctor".');
    process.exit(1);
  }
  let sel = Math.max(0, state.profiles.findIndex((p) => p.name === state!.pick.name));
  let message = state.pick.name ? dim(state.pick.reason) : `${ESC}33m${state.pick.reason}${ESC}0m`;

  const out = process.stdout;
  const draw = () => {
    const s = state!;
    const lines: string[] = [];
    lines.push('');
    lines.push(` ${b('multiclaude')}  ${dim(`pick: ${s.pickMode === 'priority' ? 'first in order with room' : 'most room left'} · switch at ${s.switchAt}%`)}`);
    lines.push(dim(' ' + '─'.repeat(Math.min(96, (out.columns ?? 100) - 2))));
    s.profiles.forEach((p, i) => lines.push(row(p, i === sel, s.pick.name)));
    if (s.fallback.enabled) {
      lines.push(`     ${dim('API key'.padEnd(21))} ${s.fallback.hasKey ? `$${s.fallback.spentToday.toFixed(2)} of $${s.fallback.dailyCapUsd} today ${dim('(used only when a plan is out)')}` : `${ESC}33mno key saved — add one in the dashboard${ESC}0m`}`);
    }
    lines.push(dim(' ' + '─'.repeat(Math.min(96, (out.columns ?? 100) - 2))));
    lines.push(` ${message}`);
    lines.push(dim(' ↵ launch   a auto-pick   r resume last session here   ↑↓ select   J/K move in order   p pause   u refresh   d dashboard   q quit'));
    out.write(`${ESC}H${ESC}2J${lines.join('\n')}\n`);
  };

  const restore = () => {
    process.stdin.setRawMode?.(false);
    process.stdin.pause();
    out.write(`${ESC}?25h${ESC}H${ESC}2J`);
  };

  const go = async (name: string, args: string[], reason?: string) => {
    restore();
    process.stdin.removeAllListeners('data');
    await launch(name, args, { reason });
  };

  out.write(`${ESC}?25l`);
  process.stdin.setRawMode?.(true);
  process.stdin.resume();
  draw();

  process.stdin.on('data', async (buf: Buffer) => {
    const k = buf.toString();
    const s = state!;
    const cur = s.profiles[sel];
    if (k === 'q' || k === '\x03' || k === '\x1b') {
      restore();
      process.exit(0);
    } else if (k === '\x1b[A' || k === 'k') sel = (sel - 1 + s.profiles.length) % s.profiles.length;
    else if (k === '\x1b[B' || k === 'j') sel = (sel + 1) % s.profiles.length;
    else if (k === '\r') {
      if (!cur.info.loggedIn) return go(cur.name, ['auth', 'login']);
      return go(cur.name, extraArgs);
    } else if (k === 'a') {
      if (!s.pick.name) message = `${ESC}33m${s.pick.reason}${ESC}0m`;
      else return go(s.pick.name, extraArgs, s.pick.reason);
    } else if (k === 'r') return go(cur.name, ['--continue', ...extraArgs], 'resuming the last session in this folder');
    else if (k === 'K' || k === 'J') {
      const order = s.profiles.map((p) => p.name);
      const to = k === 'K' ? sel - 1 : sel + 1;
      if (to >= 0 && to < order.length) {
        [order[sel], order[to]] = [order[to], order[sel]];
        sel = to;
        state = (await api(cfg.port, '/api/profiles/order', { order })) ?? s;
        message = dim(`Order: ${order.join(' → ')}`);
      }
    } else if (k === 'p') {
      state = (await api(cfg.port, `/api/profiles/${cur.name}`, { paused: !cur.paused })) ?? s;
      message = dim(`${cur.name} ${cur.paused ? 'resumed' : 'paused'}`);
    } else if (k === 'u') {
      message = dim('Refreshing…');
      draw();
      state = (await api(cfg.port, '/api/refresh', {})) ?? s;
      message = dim(state.pick.reason);
    } else if (k === 'd') {
      execFile('open', [`http://127.0.0.1:${cfg.port}/`]);
      message = dim('Opened the dashboard');
    }
    draw();
  });
}
