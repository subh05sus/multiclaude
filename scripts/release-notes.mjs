#!/usr/bin/env node
// Print the release notes for a version: its CHANGELOG.md section plus the standard
// install and menu bar notes. Used by .github/workflows/release.yml.
//
//   node scripts/release-notes.mjs 0.2.0          (or v0.2.0)
//   node scripts/release-notes.mjs 0.2.0 --section-only
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const version = (process.argv[2] ?? '').replace(/^v/, '');
if (!/^\d+\.\d+\.\d+/.test(version)) {
  console.error('Usage: node scripts/release-notes.mjs <version>');
  process.exit(1);
}

const changelog = readFileSync(join(root, 'CHANGELOG.md'), 'utf8');
const heading = new RegExp(`^## ${version.replace(/\./g, '\\.')}(\\s|$).*$`, 'm');
const m = heading.exec(changelog);
if (!m) {
  console.error(`No "## ${version}" section in CHANGELOG.md`);
  process.exit(1);
}
const rest = changelog.slice(m.index + m[0].length);
const next = rest.search(/^## /m);
const section = (next === -1 ? rest : rest.slice(0, next)).trim();

/**
 * GitHub shows every newline in release notes as a line break, and CHANGELOG.md is hard-wrapped,
 * so join wrapped lines back into their paragraph or list item. Code blocks stay as they are.
 */
function unwrap(text) {
  const out = [];
  let fence = false;
  for (const line of text.split('\n')) {
    if (line.trim().startsWith('```')) fence = !fence;
    const prev = out.length ? out[out.length - 1] : '';
    const startsBlock = /^\s*([-*] |\d+\. |#|\||```|>)/.test(line) || line.trim() === '';
    const prevJoinable = prev.trim() !== '' && !/^\s*(#|\||```)/.test(prev);
    if (!fence && !line.trim().startsWith('```') && !startsBlock && prevJoinable && out.length) out[out.length - 1] = `${prev} ${line.trim()}`;
    else out.push(line);
  }
  return out.join('\n');
}

if (process.argv.includes('--section-only')) {
  console.log(unwrap(section));
  process.exit(0);
}

const repo = 'https://github.com/subh05sus/multiclaude';
console.log(unwrap(`${section}

## Install or update

macOS / Linux:

\`\`\`sh
git clone ${repo}.git ~/multiclaude     # or download the source zip from this release
cd ~/multiclaude && ./bin/mc setup --shell
\`\`\`

Windows (PowerShell):

\`\`\`powershell
git clone ${repo}.git $HOME\\multiclaude
node --disable-warning=ExperimentalWarning $HOME\\multiclaude\\src\\cli.ts setup --shell
\`\`\`

Updating: \`git pull\` in the folder, then \`mc setup\` again. Guides: [setup](${repo}/blob/v${version}/docs/setup.md) ·
[usage](${repo}/blob/v${version}/docs/usage.md).

**MultiClaude-macOS.zip** is the optional menu bar app. It's ad-hoc signed, so the first time macOS may ask you to
right-click it and choose **Open**. You don't need it: \`mc setup\` builds it for you on macOS.`));
