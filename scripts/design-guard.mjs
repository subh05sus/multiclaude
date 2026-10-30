#!/usr/bin/env node
// Design guard for the dashboard (run by `npm run lint`). It fails the build on:
//  1. a coloured or thick edge down one side of a box (border-left, border-inline-start,
//     an inset box-shadow stripe): show status with a dot, an icon with a word or a fill;
//  2. a box that clips or scrolls (overflow auto/scroll/hidden) without inner room, which
//     cuts off its children's focus rings. Give it padding, or mark the rule
//     "/* guard: rings-inside */" when every child draws its ring inside.
//  3. raw hex colours in the script: colours come from CSS tokens.
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const WEB = join(dirname(fileURLToPath(import.meta.url)), '..', 'web');
const problems = [];

for (const f of readdirSync(WEB)) {
  const path = join(WEB, f);
  const text = readFileSync(path, 'utf8');
  if (f.endsWith('.css')) checkCss(f, text);
  if (f.endsWith('.js') && f !== 'liquid-lens.js') checkJs(f, text);
}

function lineOf(text, index) {
  return text.slice(0, index).split('\n').length;
}

function checkCss(file, text) {
  const side = /border-(left|inline-start)(-width|-color)?\s*:\s*(?!0\b|none\b)[^;]+/g;
  for (const m of text.matchAll(side)) problems.push(`${file}:${lineOf(text, m.index)} side edge "${m[0].trim()}"`);
  const stripe = /inset\s+[1-9]\d*px\s+0(px)?\s+0(px)?\s+[^,;]*(var\(|#|rgb)/g;
  for (const m of text.matchAll(stripe)) problems.push(`${file}:${lineOf(text, m.index)} inset-shadow stripe "${m[0].trim()}"`);

  const rule = /([^{}]+)\{([^{}]*)\}/g;
  for (const m of text.matchAll(rule)) {
    const [, sel, body] = m;
    if (!/overflow(-x|-y)?\s*:\s*(auto|scroll|hidden)/.test(body)) continue;
    // Padding gives rings room; text truncation and screen-reader-only boxes hold nothing focusable.
    if (/padding|text-overflow/.test(body) || /guard:\s*rings-inside/.test(body) || /sr-only|::|@keyframes|^\s*(body|html)\b/.test(sel)) continue;
    problems.push(`${file}:${lineOf(text, m.index)} "${sel.trim()}" clips without inner room (add padding or mark rings-inside)`);
  }
}

function checkJs(file, text) {
  const hex = /['"`(\s:]#[0-9a-fA-F]{3,8}\b(?![\w-])/g;
  for (const m of text.matchAll(hex)) {
    const before = text.slice(Math.max(0, m.index - 30), m.index);
    if (/querySelector|\$\(|href|id=|getElementById/.test(before)) continue;
    problems.push(`${file}:${lineOf(text, m.index)} raw colour "${m[0].trim()}" (use a CSS token)`);
  }
}

if (problems.length) {
  console.error(`design guard: ${problems.length} problem(s)\n  ${problems.join('\n  ')}`);
  process.exit(1);
}
console.log('design guard: clean');
