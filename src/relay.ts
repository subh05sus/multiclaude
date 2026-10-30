import { request as httpsRequest } from 'node:https';
import { request as httpRequest } from 'node:http';
import type { IncomingMessage, ServerResponse, IncomingHttpHeaders, OutgoingHttpHeaders } from 'node:http';
import { fallbackAllowed, type Config } from './config.ts';
import { readApiKey } from './keychain.ts';
import { costUsd, type TokenUsage } from './pricing.ts';
import { recordSpend, spentToday } from './spend.ts';
import { usageFromHeaders, type Usage } from './usage.ts';
import { logActivity, notify } from './util.ts';

/**
 * The relay passes each Claude Code request to api.anthropic.com unchanged, on the
 * account's own login. Only when Anthropic answers that the plan's limit is reached
 * does it send that same request again on your paid API key, and it keeps using the
 * key until the plan resets, up to your daily spend cap. It never moves a request to
 * another Claude account.
 */

/** Where requests go. MC_UPSTREAM exists only for tests (a fake Anthropic on localhost). */
const UPSTREAM = new URL(process.env.MC_UPSTREAM || 'https://api.anthropic.com');
const UPSTREAM_HOST = UPSTREAM.host;
const HOP = new Set(['host', 'connection', 'keep-alive', 'transfer-encoding', 'content-length', 'accept-encoding', 'proxy-authorization', 'proxy-connection', 'te', 'upgrade']);

export interface RelayHooks {
  config: () => Config;
  onUsage: (profile: string, u: Usage) => void;
  onFallbackChange: (profile: string, active: boolean, until?: number) => void;
}

/** Per-profile: when the plan resets and requests can go back to the login. */
const fallbackUntil = new Map<string, number>();

export function fallbackState(profile: string): { active: boolean; until?: number } {
  const until = fallbackUntil.get(profile);
  return until && until > Date.now() ? { active: true, until } : { active: false };
}

export function clearFallback(profile: string): void {
  fallbackUntil.delete(profile);
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const parts: Buffer[] = [];
    req.on('data', (c: Buffer) => parts.push(c));
    req.on('end', () => resolve(Buffer.concat(parts)));
    req.on('error', reject);
  });
}

function upstreamHeaders(h: IncomingHttpHeaders, body: Buffer): OutgoingHttpHeaders {
  const out: OutgoingHttpHeaders = {};
  for (const [k, v] of Object.entries(h)) if (v !== undefined && !HOP.has(k)) out[k] = v;
  out.host = UPSTREAM_HOST;
  out['accept-encoding'] = 'identity';
  out['content-length'] = body.length;
  return out;
}

/** Same request, but signed with the API key instead of the plan's login. */
function apiKeyHeaders(h: OutgoingHttpHeaders, key: string): OutgoingHttpHeaders {
  const out = { ...h };
  delete out.authorization;
  out['x-api-key'] = key;
  const beta = String(out['anthropic-beta'] ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s && !s.startsWith('oauth-'));
  if (beta.length) out['anthropic-beta'] = beta.join(',');
  else delete out['anthropic-beta'];
  return out;
}

function send(method: string, path: string, headers: OutgoingHttpHeaders, body: Buffer): Promise<IncomingMessage> {
  return new Promise((resolve, reject) => {
    const req = UPSTREAM.protocol === 'http:' ? httpRequest : httpsRequest;
    const up = req({ hostname: UPSTREAM.hostname, port: UPSTREAM.port || (UPSTREAM.protocol === 'http:' ? 80 : 443), method, path, headers }, resolve);
    up.on('error', reject);
    up.end(body);
  });
}

function responseHeaders(h: IncomingHttpHeaders): OutgoingHttpHeaders {
  const out: OutgoingHttpHeaders = {};
  for (const [k, v] of Object.entries(h)) if (v !== undefined && !['connection', 'keep-alive', 'transfer-encoding'].includes(k)) out[k] = v;
  return out;
}

function drain(res: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve) => {
    const parts: Buffer[] = [];
    res.on('data', (c: Buffer) => parts.push(c));
    res.on('end', () => resolve(Buffer.concat(parts)));
    res.on('error', () => resolve(Buffer.concat(parts)));
  });
}

function isPlanLimit(res: IncomingMessage): boolean {
  if (res.statusCode !== 429) return false;
  const status = res.headers['anthropic-ratelimit-unified-status'];
  return status === 'rejected' || res.headers['anthropic-ratelimit-unified-5h-status'] === 'rejected' || res.headers['anthropic-ratelimit-unified-7d-status'] === 'rejected';
}

function resetTime(res: IncomingMessage): number {
  const raw = Number(res.headers['anthropic-ratelimit-unified-reset']);
  if (Number.isFinite(raw) && raw > 0) return raw < 1e12 ? raw * 1000 : raw;
  return Date.now() + 60 * 60 * 1000;
}

/** Pipe a reply to Claude Code while reading its token counts, so the key's spend is known. */
function pipeAndMeter(up: IncomingMessage, res: ServerResponse, onDone: (model: string | undefined, u: TokenUsage) => void): void {
  res.writeHead(up.statusCode ?? 502, responseHeaders(up.headers));
  const isStream = String(up.headers['content-type'] ?? '').includes('event-stream');
  let buf = '';
  let model: string | undefined;
  const usage: TokenUsage = {};
  up.on('data', (chunk: Buffer) => {
    res.write(chunk);
    if (buf.length < 4_000_000) buf += chunk.toString('utf8');
    if (!isStream) return;
    let i: number;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const block = buf.slice(0, i);
      buf = buf.slice(i + 2);
      const data = block.split('\n').find((l) => l.startsWith('data:'));
      if (!data) continue;
      try {
        const ev = JSON.parse(data.slice(5));
        if (ev.type === 'message_start') {
          model = ev.message?.model;
          Object.assign(usage, ev.message?.usage ?? {});
        } else if (ev.type === 'message_delta' && ev.usage) {
          Object.assign(usage, ev.usage);
        }
      } catch {
        /* partial or non-JSON line */
      }
    }
  });
  up.on('end', () => {
    res.end();
    if (!isStream) {
      try {
        const j = JSON.parse(buf);
        model = j.model;
        Object.assign(usage, j.usage ?? {});
      } catch {
        /* not JSON */
      }
    }
    onDone(model, usage);
  });
  up.on('error', () => res.destroy());
  res.on('close', () => up.destroy());
}

function plainPipe(up: IncomingMessage, res: ServerResponse): void {
  res.writeHead(up.statusCode ?? 502, responseHeaders(up.headers));
  up.pipe(res);
  res.on('close', () => up.destroy());
}

function fail(res: ServerResponse, status: number, message: string): void {
  if (res.headersSent) return void res.destroy();
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ type: 'error', error: { type: status === 429 ? 'rate_limit_error' : 'api_error', message } }));
}

export async function handleRelay(req: IncomingMessage, res: ServerResponse, profile: string, path: string, hooks: RelayHooks): Promise<void> {
  const method = req.method ?? 'GET';
  let body: Buffer;
  try {
    body = await readBody(req);
  } catch {
    return fail(res, 400, 'multiclaude relay: could not read the request');
  }
  const headers = upstreamHeaders(req.headers, body);
  const billable = path.startsWith('/v1/messages') && !path.startsWith('/v1/messages/count_tokens');
  const requestModel = (() => {
    try {
      return JSON.parse(body.toString('utf8')).model as string | undefined;
    } catch {
      return undefined;
    }
  })();

  const canSpend = () => fallbackAllowed(hooks.config(), profile) && spentToday() < hooks.config().fallback.dailyCapUsd;

  const viaKey = async (original?: { res: IncomingMessage; body: Buffer }): Promise<boolean> => {
    const key = await readApiKey();
    if (!key) {
      logActivity('error', 'Plan limit reached but no API key is saved for the fallback', profile);
      return false;
    }
    try {
      const up = await send(method, path, apiKeyHeaders(headers, key), body);
      pipeAndMeter(up, res, (model, u) => {
        if (!billable || (up.statusCode ?? 500) >= 400) return;
        const usd = costUsd(model ?? requestModel ?? '', u);
        recordSpend(profile, model ?? requestModel ?? 'unknown', usd);
        if (spentToday() >= hooks.config().fallback.dailyCapUsd) {
          logActivity('fallback-cap', `Daily API cap of $${hooks.config().fallback.dailyCapUsd} reached`, profile);
          notify('multiclaude', `Daily API fallback cap ($${hooks.config().fallback.dailyCapUsd}) reached. Requests go back to your plan.`);
        }
      });
      return true;
    } catch {
      if (original) {
        plainPipeBuffered(original.res, original.body, res);
        return true;
      }
      return false;
    }
  };

  // While the plan is out and the cap allows, go straight to the key.
  const fb = fallbackState(profile);
  if (fb.active && billable && canSpend()) {
    if (await viaKey()) return;
  } else if (!fb.active && fallbackUntil.has(profile)) {
    fallbackUntil.delete(profile);
    hooks.onFallbackChange(profile, false);
    logActivity('fallback-off', 'Plan has reset; back on the subscription', profile);
  }

  let up: IncomingMessage;
  try {
    up = await send(method, path, headers, body);
  } catch (e) {
    return fail(res, 502, `multiclaude relay: could not reach Anthropic (${(e as Error).message})`);
  }
  const u = usageFromHeaders(up.headers);
  if (u) hooks.onUsage(profile, u);

  if (isPlanLimit(up) && billable && canSpend()) {
    const original = await drain(up);
    const until = resetTime(up);
    fallbackUntil.set(profile, until);
    hooks.onFallbackChange(profile, true, until);
    const at = new Date(until).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    logActivity('fallback-on', `Plan limit reached; using the API key until ${at}`, profile);
    notify('multiclaude', `${profile} hit its plan limit. Continuing on your API key until ${at} (cap $${hooks.config().fallback.dailyCapUsd}/day).`);
    if (await viaKey({ res: up, body: original })) return;
    return plainPipeBuffered(up, original, res);
  }
  plainPipe(up, res);
}

function plainPipeBuffered(up: IncomingMessage, body: Buffer, res: ServerResponse): void {
  if (res.headersSent) return void res.end();
  const h = responseHeaders(up.headers);
  h['content-length'] = body.length;
  res.writeHead(up.statusCode ?? 429, h);
  res.end(body);
}
