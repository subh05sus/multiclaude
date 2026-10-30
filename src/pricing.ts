/**
 * API list prices in US dollars per million tokens, used for the fallback spend cap
 * and for the "API value" estimate on the Stats page. Cache writes are 1.25x input for
 * the 5-minute cache and 2x for the 1-hour cache.
 */
interface Price {
  input: number;
  output: number;
  cacheRead: number;
}

const PRICES: [RegExp, Price][] = [
  [/fable|mythos/, { input: 10, output: 50, cacheRead: 0.25 }],
  [/opus-5-5/, { input: 4, output: 20, cacheRead: 0.2 }],
  [/opus-(5|4-[5-9])/, { input: 5, output: 25, cacheRead: 0.5 }],
  [/opus/, { input: 15, output: 75, cacheRead: 1.5 }],
  [/sonnet-5/, { input: 2, output: 10, cacheRead: 0.2 }],
  [/sonnet/, { input: 3, output: 15, cacheRead: 0.3 }],
  [/haiku-5/, { input: 0.1, output: 0.5, cacheRead: 0.01 }],
  [/haiku-4/, { input: 1, output: 5, cacheRead: 0.1 }],
  [/haiku/, { input: 0.8, output: 4, cacheRead: 0.08 }],
];

export interface TokenUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_creation?: { ephemeral_5m_input_tokens?: number; ephemeral_1h_input_tokens?: number };
}

export function priceFor(model: string): Price {
  const m = model.toLowerCase();
  for (const [re, p] of PRICES) if (re.test(m)) return p;
  return { input: 4, output: 20, cacheRead: 0.2 };
}

export function costUsd(model: string, u: TokenUsage): number {
  const p = priceFor(model);
  const c1h = u.cache_creation?.ephemeral_1h_input_tokens ?? 0;
  const c5m = u.cache_creation?.ephemeral_5m_input_tokens ?? Math.max(0, (u.cache_creation_input_tokens ?? 0) - c1h);
  const dollars =
    (u.input_tokens ?? 0) * p.input +
    (u.output_tokens ?? 0) * p.output +
    (u.cache_read_input_tokens ?? 0) * p.cacheRead +
    c5m * p.input * 1.25 +
    c1h * p.input * 2;
  return dollars / 1_000_000;
}

/** "claude-opus-5-5" -> "Opus 5.5" */
export function modelLabel(model: string): string {
  const m = /claude-([a-z]+)-(\d+)(?:-(\d+))?/.exec(model);
  if (!m) return model;
  const fam = m[1].charAt(0).toUpperCase() + m[1].slice(1);
  return `${fam} ${m[2]}${m[3] && m[3].length <= 2 ? `.${m[3]}` : ''}`;
}
