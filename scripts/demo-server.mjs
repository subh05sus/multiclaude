#!/usr/bin/env node
// Serves the dashboard with made-up sample data, for screenshots and for trying the UI
// without any Claude account. Nothing here touches your real setup.
//
//   node scripts/demo-server.mjs [port]     then open http://127.0.0.1:4899
import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const WEB = join(dirname(fileURLToPath(import.meta.url)), '..', 'web');
const PORT = Number(process.argv[2] || 4899);
const now = Date.now();
const H = 3600_000;

const profile = (name, color, position, email, plan, five, week, extra = {}) => ({
  name, color, position, paused: false, switchAt: 90, label: undefined,
  info: { name, exists: true, loggedIn: true, email, plan },
  usage: { source: 'statusline', at: now, fiveHour: { pct: five, resetsAt: now + 2.7 * H }, sevenDay: { pct: week, resetsAt: now + 4.2 * 24 * H } },
  peak: Math.max(five, week), fallback: { active: false }, ...extra,
});

const state = {
  version: '0.1.0', updatedAt: now, port: PORT, pickMode: 'priority', switchAt: 90, defaultProfile: 'work',
  terminalApp: 'Terminal', pollMinutes: 5,
  alerts: { enabled: true, thresholds: [80, 95], notifyReset: true },
  fallback: { enabled: true, dailyCapUsd: 5, assumeFirstParty: true, profiles: [], spentToday: 1.24, hasKey: true },
  profiles: [
    profile('work', 0, 1, 'dev@example.com', 'Max 20x', 94, 41, { label: 'Team Max' }),
    profile('personal', 1, 2, 'me@example.com', 'Max 5x', 38, 22),
    profile('side', 2, 3, 'side@example.com', 'Pro', 12, 4),
  ],
  pick: null,
};
state.profiles[0].usage.models = { opus: { pct: 55, resetsAt: now + 4 * 24 * H } };

function repick() {
  state.profiles.forEach((p, i) => (p.position = i + 1));
  const ranked = state.profiles.map((p) => {
    const skip = p.paused ? 'paused' : p.peak >= p.switchAt ? `at ${Math.round(p.peak)}%` : undefined;
    return { name: p.name, room: !skip, peak: p.peak, skip };
  });
  const open = ranked.filter((r) => r.room);
  const first = state.pickMode === 'most-room' ? [...open].sort((a, b) => a.peak - b.peak)[0] : open[0];
  const skipped = ranked.slice(0, ranked.indexOf(first)).filter((r) => r.skip);
  state.pick = first
    ? { name: first.name, reason: state.pickMode === 'most-room' ? `${first.name} has the most room left` : `${first.name} is first in your order with room${skipped.length ? ` (skipped ${skipped.map((s) => `${s.name}: ${s.skip}`).join(', ')})` : ''}`, ranked }
    : { name: null, reason: 'Every account is full, paused or signed out.', ranked };
}
repick();

const titles = [
  ['Fix the login redirect loop', '~/code/shop-web', 'fix/login'],
  ['Add dark mode to settings', '~/code/shop-web', 'main'],
  ['Migrate payments to the new API', '~/code/billing', 'payments-v2'],
  ['Write onboarding emails', '~/notes/marketing', ''],
  ['Speed up the image pipeline', '~/code/media', 'perf'],
  ['Refactor the search index', '~/code/shop-web', 'search'],
  ['Draft the Q4 roadmap', '~/notes/planning', ''],
  ['Debug flaky checkout test', '~/code/shop-web', 'main'],
];
const sessions = titles.map(([title, cwd, branch], i) => ({
  id: `0000000${i}-demo-4000-8000-00000000000${i}`, file: '', project: cwd, cwd: cwd.replace('~', '/Users/you'), branch,
  title, updatedAt: new Date(now - [0.1, 1.5, 3, 20, 26, 50, 75, 120][i] * H).toISOString(), sizeBytes: 1, profile: ['work', 'work', 'personal', 'side', 'personal', 'work', 'side', 'personal'][i],
}));

function seeded(i) {
  const x = Math.sin(i * 12.9898) * 43758.5453;
  return x - Math.floor(x);
}
function stats(days) {
  const out = [];
  let total = 0;
  const byProfile = { work: 0, personal: 0, side: 0 };
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(now - i * 24 * H);
    const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const weekend = d.getDay() === 0 || d.getDay() === 6;
    const base = weekend ? 8 : 30;
    const p = { work: +(base * (0.6 + seeded(i) * 1.4)).toFixed(2), personal: +(base * 0.6 * seeded(i + 99)).toFixed(2), side: +(base * 0.25 * seeded(i + 7)).toFixed(2) };
    const cost = p.work + p.personal + p.side;
    Object.keys(p).forEach((k) => (byProfile[k] += p[k]));
    total += cost;
    out.push({ day, cost, tokens: cost * 350_000, byProfile: p });
  }
  const rows = (o) => Object.entries(o).map(([key, cost]) => ({ key, cost, tokens: cost * 350_000, msgs: Math.round(cost * 6) })).sort((a, b) => b.cost - a.cost);
  return {
    rangeDays: days,
    totals: { cost: total, tokens: total * 350_000, msgs: Math.round(total * 6), sessions: Math.round(days * 3.4) },
    days: out,
    byProfile: rows(byProfile),
    byModel: rows({ 'claude-opus-5-5': total * 0.78, 'claude-sonnet-5-5': total * 0.19, 'claude-haiku-5-5': total * 0.03 }),
    byProject: rows({ 'shop-web': total * 0.46, billing: total * 0.22, media: total * 0.14, marketing: total * 0.1, planning: total * 0.08 }),
    spend: { days: { [out.at(-1).day]: { total: 1.24, requests: 9, byProfile: { work: 1.24 }, byModel: {} } } },
  };
}

const activity = [
  ['alert', 'work', '94% of the 5-hour limit; next with room: personal', 0.2],
  ['fallback-on', 'work', 'Plan limit reached; using the API key until 6:40 PM', 0.4],
  ['switch', 'personal', 'Moved "Fix the login redirect loop" from work to personal', 0.5],
  ['settings', undefined, 'Priority order: work → personal → side', 3],
  ['reset', 'side', 'weekly window reset', 22],
  ['launch', 'side', 'Started Claude Code', 23],
  ['profile-added', 'side', 'Profile created', 26],
].map(([kind, profile, text, h]) => ({ at: new Date(now - h * H).toISOString(), kind, profile, text }));

const handover = (id) => {
  const s = sessions.find((x) => x.id === id) ?? sessions[0];
  return {
    markdown: `# Handover: ${s.title}\n\nMoved from the **${s.profile}** account.\n\n## What the session set out to do\n\n${s.title}.\n\n## Todo list at handover\n\n- [x] Reproduce it\n- [ ] Write the fix\n- [ ] Add a test\n`,
    handover: { sessionId: s.id, title: s.title, goal: `${s.title}. Start by reproducing it locally, then fix it and add a test so it stays fixed.`, recent: ['a', 'b', 'c'], files: ['a', 'b', 'c', 'd', 'e'], todos: [{ content: 'x', status: 'completed' }, { content: 'y', status: 'pending' }, { content: 'z', status: 'pending' }] },
  };
};

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };
const send = (res, code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };

createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  const p = url.pathname;
  let body = {};
  if (req.method === 'POST') {
    let raw = '';
    for await (const c of req) raw += c;
    try { body = JSON.parse(raw || '{}'); } catch { /* ignore */ }
  }
  if (p === '/api/state' || p === '/api/refresh') return send(res, 200, state);
  if (p === '/api/sessions') return send(res, 200, sessions);
  if (p === '/api/stats') return send(res, 200, stats(Number(url.searchParams.get('days') || 30)));
  if (p === '/api/activity') return send(res, 200, activity);
  if (p.startsWith('/api/handover/')) return send(res, 200, handover(p.split('/').pop()));
  if (p === '/api/profiles/order') {
    state.profiles.sort((a, b) => body.order.indexOf(a.name) - body.order.indexOf(b.name));
    repick();
    return send(res, 200, state);
  }
  if (p === '/api/config') {
    if (body.pick) state.pickMode = body.pick;
    if (body.switchAt) state.switchAt = body.switchAt;
    repick();
    return send(res, 200, state);
  }
  if (p.startsWith('/api/profiles/')) {
    const pr = state.profiles.find((x) => x.name === p.split('/')[3]);
    if (pr && typeof body.paused === 'boolean') pr.paused = body.paused;
    if (pr && typeof body.switchAt === 'number') pr.switchAt = body.switchAt;
    repick();
    return send(res, 200, state);
  }
  if (p.startsWith('/api/')) return send(res, 200, { ok: true });
  const file = p === '/' ? 'index.html' : p.slice(1);
  const path = join(WEB, file);
  if (!path.startsWith(WEB) || !existsSync(path)) return send(res, 404, { error: 'not found' });
  let out = readFileSync(path);
  if (file === 'index.html') out = out.toString().replace('__MC_SECRET__', 'demo');
  res.writeHead(200, { 'content-type': TYPES[extname(path)] ?? 'application/octet-stream' });
  res.end(out);
}).listen(PORT, '127.0.0.1', () => console.log(`multiclaude demo on http://127.0.0.1:${PORT}`));
