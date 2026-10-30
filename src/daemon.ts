import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFileSync, existsSync, writeFileSync, mkdirSync, watch } from 'node:fs';
import { join, extname } from 'node:path';
import { loadConfig, saveConfig, type Config } from './config.ts';
import { MC_DIR, WEB_DIR, STATE_FILE, ACTIVITY_FILE, MAIN_PROFILE, LIVE_USAGE_DIR, MC_BIN } from './paths.ts';
import { getSecret, writeJson, readJsonLines, logActivity, openInTerminal, shellQuote, isValidProfileName, type Activity } from './util.ts';
import { profileInfo, ensureLinks, accountUuidMap, removeProfileDir, isMain, configDirEnv, type ProfileInfo } from './profiles.ts';
import { fetchUsage, readLiveUsage, mergeUsage, peakPct, writeLiveUsage, writeApiUsage, ownerOf, type Usage } from './usage.ts';
import { pickAccount, reorder, switchAtFor } from './pick.ts';
import { checkAlerts, wouldAlert } from './alerts.ts';
import { handleRelay, fallbackState, clearFallback } from './relay.ts';
import { readApiKey, saveApiKey, deleteApiKey, deleteGenericPassword, claudeKeychainService } from './keychain.ts';
import { spentToday, readSpend } from './spend.ts';
import { listSessions, statsReport, refreshStats } from './sessions.ts';
import { buildHandover, handoverMarkdown } from './handover.ts';
import type { AppState, ProfileState } from './state.ts';

const VERSION = '0.1.1';

const apiUsage = new Map<string, Usage>();
const infoCache = new Map<string, { at: number; info: ProfileInfo }>();
let state: AppState | null = null;
let hasKey = false;

async function info(name: string, force = false): Promise<ProfileInfo> {
  const c = infoCache.get(name);
  if (!force && c && Date.now() - c.at < 60_000) return c.info;
  const i = await profileInfo(name);
  infoCache.set(name, { at: Date.now(), info: i });
  return i;
}

function usageFor(name: string): Usage {
  return mergeUsage([apiUsage.get(name), readLiveUsage(name)]);
}

async function buildState(cfg: Config): Promise<AppState> {
  hasKey = Boolean(await readApiKey());
  const profiles: ProfileState[] = [];
  for (const [i, p] of cfg.profiles.entries()) {
    const usage = usageFor(p.name);
    profiles.push({
      name: p.name,
      label: p.label,
      color: p.color ?? 0,
      paused: Boolean(p.paused),
      switchAt: switchAtFor(cfg, p.name),
      position: i + 1,
      info: await info(p.name),
      usage,
      peak: peakPct(usage),
      fallback: fallbackState(p.name),
    });
  }
  const pick = pickAccount(cfg, profiles.map((p) => ({ name: p.name, loggedIn: p.info.loggedIn, usage: p.usage })));
  return {
    version: VERSION,
    updatedAt: Date.now(),
    port: cfg.port,
    pickMode: cfg.pick,
    switchAt: cfg.switchAt,
    defaultProfile: cfg.defaultProfile,
    terminalApp: cfg.terminalApp,
    pollMinutes: cfg.pollMinutes,
    pick,
    alerts: cfg.alerts,
    fallback: { ...cfg.fallback, spentToday: spentToday(), hasKey },
    profiles,
  };
}

const confirming = new Set<string>();
const lastConfirm = new Map<string, number>();

async function rebuild(): Promise<AppState> {
  const cfg = loadConfig();
  state = await buildState(cfg);
  writeJson(STATE_FILE, state);
  for (const p of state.profiles) {
    if (p.usage.error) continue;
    // A status-line or relay reading can be stale or odd. Before notifying, ask Anthropic's
    // usage endpoint; its fresh reading wins the merge, and the alert uses that.
    if (p.usage.source !== 'api' && wouldAlert(cfg, p.name, p.usage)) {
      if (!confirming.has(p.name) && Date.now() - (lastConfirm.get(p.name) ?? 0) > 5 * 60_000) {
        confirming.add(p.name);
        lastConfirm.set(p.name, Date.now());
        void fetchUsage(p.name)
          .then((u) => {
            if (!u.error) {
              apiUsage.set(p.name, u);
              writeApiUsage(p.name, u);
            }
          })
          .finally(() => {
            confirming.delete(p.name);
            void rebuildWithApi(p.name);
          });
      }
      continue;
    }
    checkAlerts(cfg, p.name, p.usage, () => pickAccount(cfg, state!.profiles.map((x) => ({ name: x.name, loggedIn: x.info.loggedIn, usage: x.usage })), [p.name]).name);
  }
  return state;
}

/** After a confirming check: alert only from the API's own reading, if it still crosses. */
async function rebuildWithApi(name: string): Promise<void> {
  const cfg = loadConfig();
  state = await buildState(cfg);
  writeJson(STATE_FILE, state);
  const api = apiUsage.get(name);
  const p = state.profiles.find((x) => x.name === name);
  if (!api || api.error || !p) return;
  checkAlerts(cfg, name, api, () => pickAccount(cfg, state!.profiles.map((x) => ({ name: x.name, loggedIn: x.info.loggedIn, usage: x.usage })), [name]).name);
}

/** Ask Anthropic for usage, skipping accounts whose open session reported in the last 2 minutes. */
async function poll(force = false): Promise<void> {
  const cfg = loadConfig();
  for (const p of cfg.profiles) {
    const live = readLiveUsage(p.name);
    if (!force && live && Date.now() - live.at < 120_000) continue;
    const prev = apiUsage.get(p.name);
    if (!force && prev && Date.now() - prev.at < cfg.pollMinutes * 60_000 - 5_000) continue;
    const u = await fetchUsage(p.name);
    // Keep the last good reading if this one failed.
    if (u.error && prev && !prev.error) apiUsage.set(p.name, { ...prev, error: undefined });
    else apiUsage.set(p.name, u);
    if (!u.error) writeApiUsage(p.name, u);
  }
  await rebuild();
}

// ---------------------------------------------------------------- http

function json(res: ServerResponse, status: number, body: unknown): void {
  const s = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(s);
}

async function readJsonBody<T>(req: IncomingMessage): Promise<T> {
  const parts: Buffer[] = [];
  for await (const c of req) {
    parts.push(c as Buffer);
    if (parts.reduce((n, b) => n + b.length, 0) > 1_000_000) throw new Error('too large');
  }
  const s = Buffer.concat(parts).toString('utf8');
  return (s ? JSON.parse(s) : {}) as T;
}

const TYPES: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png' };

function serveStatic(res: ServerResponse, file: string, secret: string): void {
  const path = join(WEB_DIR, file);
  if (!path.startsWith(WEB_DIR) || !existsSync(path)) return json(res, 404, { error: 'not found' });
  let body: string | Buffer = readFileSync(path);
  if (file === 'index.html') body = body.toString('utf8').replace('__MC_SECRET__', secret);
  res.writeHead(200, {
    'content-type': TYPES[extname(path)] ?? 'application/octet-stream',
    'cache-control': 'no-store',
    'content-security-policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'",
    'x-content-type-options': 'nosniff',
  });
  res.end(body);
}

type Body = Record<string, unknown>;

function launchCommand(profile: string, opts: { cwd?: string; sessionId?: string; mode?: string }): string {
  const parts: string[] = [];
  if (opts.cwd && existsSync(opts.cwd)) parts.push(`cd ${shellQuote(opts.cwd)} &&`);
  parts.push(shellQuote(MC_BIN));
  if (opts.mode === 'handover' && opts.sessionId) parts.push('handover', shellQuote(opts.sessionId), '--to', shellQuote(profile));
  else if (opts.mode === 'resume' && opts.sessionId) parts.push('resume', shellQuote(profile), shellQuote(opts.sessionId));
  else if (opts.mode === 'login') parts.push(shellQuote(profile), 'auth', 'login');
  else parts.push(shellQuote(profile));
  return parts.join(' ');
}

async function handleApi(req: IncomingMessage, res: ServerResponse, url: URL, secret: string): Promise<void> {
  const method = req.method ?? 'GET';
  const path = url.pathname;

  if (method === 'GET') {
    if (path === '/api/ping') return json(res, 200, { ok: true, version: VERSION });
    if (path === '/api/state') return json(res, 200, state ?? (await rebuild()));
    if (path === '/api/sessions') {
      const cfg = loadConfig();
      return json(res, 200, listSessions(Number(url.searchParams.get('limit') ?? 40), accountUuidMap(cfg.profiles.map((p) => p.name))));
    }
    if (path === '/api/stats') {
      const cfg = loadConfig();
      const days = Math.min(365, Math.max(1, Number(url.searchParams.get('days') ?? 30)));
      return json(res, 200, { ...(await statsReport(days, accountUuidMap(cfg.profiles.map((p) => p.name)))), spend: readSpend() });
    }
    if (path === '/api/activity') {
      const limit = Number(url.searchParams.get('limit') ?? 200);
      return json(res, 200, readJsonLines<Activity>(ACTIVITY_FILE).slice(-limit).reverse());
    }
    const hm = /^\/api\/handover\/([\w-]+)$/.exec(path);
    if (hm) {
      try {
        const h = buildHandover(hm[1]);
        return json(res, 200, { markdown: handoverMarkdown(h, url.searchParams.get('from') ?? '?', url.searchParams.get('to') ?? '?'), handover: h });
      } catch (e) {
        return json(res, 404, { error: (e as Error).message });
      }
    }
    return json(res, 404, { error: 'not found' });
  }

  // Everything that changes something needs the secret.
  if (req.headers['x-mc-token'] !== secret) return json(res, 403, { error: 'missing or wrong token' });
  let body: Body;
  try {
    body = await readJsonBody<Body>(req);
  } catch {
    return json(res, 400, { error: 'bad JSON' });
  }

  if (path === '/api/refresh') {
    for (const n of infoCache.keys()) infoCache.delete(n);
    await poll(true);
    return json(res, 200, state);
  }
  if (path === '/api/config') {
    const cfg = loadConfig();
    if (body.pick === 'priority' || body.pick === 'most-room') cfg.pick = body.pick;
    if (typeof body.switchAt === 'number') cfg.switchAt = clamp(body.switchAt, 10, 100);
    if (typeof body.pollMinutes === 'number') cfg.pollMinutes = clamp(body.pollMinutes, 1, 60);
    if (body.terminalApp === 'Terminal' || body.terminalApp === 'iTerm') cfg.terminalApp = body.terminalApp;
    if (typeof body.defaultProfile === 'string' && cfg.profiles.some((p) => p.name === body.defaultProfile)) cfg.defaultProfile = body.defaultProfile;
    const a = body.alerts as Partial<Config['alerts']> | undefined;
    if (a) {
      if (typeof a.enabled === 'boolean') cfg.alerts.enabled = a.enabled;
      if (typeof a.notifyReset === 'boolean') cfg.alerts.notifyReset = a.notifyReset;
      if (Array.isArray(a.thresholds)) cfg.alerts.thresholds = [...new Set(a.thresholds.map(Number).filter((n) => n > 0 && n <= 100))].sort((x, y) => x - y);
    }
    const f = body.fallback as Partial<Config['fallback']> | undefined;
    if (f) {
      if (typeof f.enabled === 'boolean') cfg.fallback.enabled = f.enabled;
      if (typeof f.dailyCapUsd === 'number') cfg.fallback.dailyCapUsd = clamp(f.dailyCapUsd, 0, 1000);
      if (typeof f.assumeFirstParty === 'boolean') cfg.fallback.assumeFirstParty = f.assumeFirstParty;
      if (Array.isArray(f.profiles)) cfg.fallback.profiles = f.profiles.filter((n) => cfg.profiles.some((p) => p.name === n));
    }
    saveConfig(cfg);
    logActivity('settings', 'Settings changed in the dashboard');
    return json(res, 200, await rebuild());
  }
  if (path === '/api/profiles/order' && Array.isArray(body.order)) {
    const cfg = loadConfig();
    reorder(cfg, body.order.map(String));
    saveConfig(cfg);
    logActivity('settings', `Priority order: ${cfg.profiles.map((p) => p.name).join(' → ')}`);
    return json(res, 200, await rebuild());
  }
  if (path === '/api/profiles/add') {
    const name = String(body.name ?? '').toLowerCase();
    if (!isValidProfileName(name)) return json(res, 400, { error: 'Use 1-32 lowercase letters, numbers, - or _.' });
    await openInTerminal(`${shellQuote(MC_BIN)} add ${shellQuote(name)}${body.label ? ` --label ${shellQuote(String(body.label))}` : ''}`, loadConfig().terminalApp);
    return json(res, 200, { ok: true });
  }
  const pm = /^\/api\/profiles\/([\w-]+)(\/remove)?$/.exec(path);
  if (pm) {
    const name = pm[1];
    const cfg = loadConfig();
    const p = cfg.profiles.find((x) => x.name === name);
    if (!p) return json(res, 404, { error: 'no such profile' });
    if (pm[2]) {
      if (isMain(name)) return json(res, 400, { error: 'main is your normal ~/.claude and stays.' });
      cfg.profiles = cfg.profiles.filter((x) => x.name !== name);
      if (cfg.defaultProfile === name) cfg.defaultProfile = MAIN_PROFILE;
      saveConfig(cfg);
      const service = claudeKeychainService(configDirEnv(name));
      removeProfileDir(name);
      await deleteGenericPassword(service);
      logActivity('profile-removed', 'Profile removed and signed out', name);
      return json(res, 200, await rebuild());
    }
    if (typeof body.label === 'string') p.label = body.label.slice(0, 40) || undefined;
    if (typeof body.paused === 'boolean') p.paused = body.paused || undefined;
    if (body.switchAt === null) delete p.switchAt;
    else if (typeof body.switchAt === 'number') p.switchAt = clamp(body.switchAt, 10, 100);
    saveConfig(cfg);
    return json(res, 200, await rebuild());
  }
  if (path === '/api/launch') {
    const cfg = loadConfig();
    let profile = String(body.profile ?? '');
    if (profile === 'auto') profile = state?.pick.name ?? cfg.defaultProfile;
    if (!cfg.profiles.some((p) => p.name === profile)) return json(res, 400, { error: 'no such profile' });
    const cmd = launchCommand(profile, { cwd: body.cwd as string | undefined, sessionId: body.sessionId as string | undefined, mode: body.mode as string | undefined });
    try {
      await openInTerminal(cmd, cfg.terminalApp);
    } catch (e) {
      return json(res, 500, { error: `Could not open ${cfg.terminalApp}: ${(e as Error).message}`, command: cmd });
    }
    return json(res, 200, { ok: true, command: cmd });
  }
  if (path === '/api/apikey') {
    if (body.remove) {
      await deleteApiKey();
      logActivity('settings', 'API key removed');
    } else {
      const key = String(body.key ?? '').trim();
      if (!/^sk-ant-[\w-]{20,}$/.test(key)) return json(res, 400, { error: 'That does not look like an Anthropic API key (sk-ant-…).' });
      if (!(await saveApiKey(key))) return json(res, 500, { error: 'Could not save the key to the Keychain.' });
      logActivity('settings', 'API key saved to the Keychain');
    }
    return json(res, 200, await rebuild());
  }
  if (path === '/api/fallback/clear' && typeof body.profile === 'string') {
    clearFallback(body.profile);
    logActivity('fallback-off', 'Switched back to the plan by hand', body.profile);
    return json(res, 200, await rebuild());
  }
  return json(res, 404, { error: 'not found' });
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, Math.round(n)));
}

export async function runDaemon(): Promise<void> {
  const cfg = loadConfig();
  // Write the config once so colour slots and defaults are fixed on disk.
  saveConfig(cfg);
  const secret = getSecret();
  const port = cfg.port;
  const hostOk = (h?: string) => h === `127.0.0.1:${port}` || h === `localhost:${port}`;
  mkdirSync(LIVE_USAGE_DIR, { recursive: true, mode: 0o700 });

  const server = createServer(async (req, res) => {
    try {
      // Refuse anything not addressed to this machine by name (stops DNS-rebinding pages).
      if (!hostOk(req.headers.host)) return json(res, 421, { error: 'wrong host' });
      const origin = req.headers.origin;
      if (origin && origin !== `http://127.0.0.1:${port}` && origin !== `http://localhost:${port}`) return json(res, 403, { error: 'cross-origin request refused' });
      const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);

      const rm = /^\/relay\/([^/]+)\/([\w-]+)(\/.*)$/.exec(url.pathname);
      if (rm) {
        if (rm[1] !== secret) return json(res, 403, { error: 'bad relay token' });
        const profile = rm[2];
        return handleRelay(req, res, profile, rm[3] + url.search, {
          config: loadConfig,
          onUsage: (p, u) => {
            const owner = ownerOf(p, u, loadConfig().profiles.map((x) => x.name), (n) => apiUsage.get(n) ?? null);
            if (owner) writeLiveUsage(owner, u);
          },
          onFallbackChange: () => void rebuild(),
        });
      }
      if (url.pathname.startsWith('/api/')) return handleApi(req, res, url, secret);
      if (url.pathname === '/' || url.pathname === '/index.html') return serveStatic(res, 'index.html', secret);
      if (/^\/[\w.-]+\.(js|css|svg|png)$/.test(url.pathname)) return serveStatic(res, url.pathname.slice(1), secret);
      return json(res, 404, { error: 'not found' });
    } catch (e) {
      if (!res.headersSent) json(res, 500, { error: (e as Error).message });
      else res.destroy();
    }
  });
  server.requestTimeout = 0;
  server.headersTimeout = 60_000;

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve());
  });
  writeFileSync(join(MC_DIR, 'daemon.pid'), String(process.pid));
  console.log(`multiclaude ${VERSION} listening on http://127.0.0.1:${port}`);

  const heal = () => {
    for (const p of loadConfig().profiles) if (!isMain(p.name)) try { ensureLinks(p.name); } catch (e) { logActivity('error', `Could not fix shared links: ${(e as Error).message}`, p.name); }
  };
  heal();
  await poll(true).catch((e) => console.error('first poll failed', e));
  setInterval(() => void poll().catch(() => {}), 60_000);
  setInterval(() => void rebuild().catch(() => {}), 15_000);
  setInterval(heal, 5 * 60_000);
  setInterval(() => void refreshStats().catch(() => {}), 15 * 60_000);
  setTimeout(() => void refreshStats().catch(() => {}), 5_000);
  // React quickly when an open session's status line reports new usage.
  let pending: NodeJS.Timeout | null = null;
  try {
    watch(LIVE_USAGE_DIR, () => {
      if (pending) return;
      pending = setTimeout(() => {
        pending = null;
        void rebuild().catch(() => {});
      }, 1500);
    });
  } catch {
    /* polling covers it */
  }
}
