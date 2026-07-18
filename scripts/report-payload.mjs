#!/usr/bin/env node
/**
 * Prints a Markdown report of what the deployed site actually costs to load.
 *
 * Two numbers matter and they are not the same:
 *
 * - **First load** — the entry HTML plus the scripts and stylesheets it
 *   references directly. This is what a visitor waits for before anything can
 *   render, and it is the number the payload budget in docs/deploy.md applies
 *   to.
 * - **Everything else** — lazily imported chunks, textures, environment maps,
 *   source maps. Shipped, but off the first-paint path, so a few megabytes of
 *   HDR here is not the same problem as a few megabytes of JavaScript there.
 *
 * Source maps are excluded from both totals on purpose: browsers fetch them
 * only when devtools is open, so counting them would make the budget
 * meaningless.
 *
 * Written to the CI step summary by the deploy workflow, and runnable locally:
 *   npm run build && node scripts/report-payload.mjs
 */

import { gzipSync } from 'node:zlib';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const distDir = process.argv[2] ?? 'dist';
const ENTRY_HTML = 'index.html';

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) out.push(...walk(path));
    else out.push(path);
  }
  return out;
}

function kb(bytes) {
  return `${(bytes / 1024).toFixed(1)} kB`;
}

function measure(path) {
  const bytes = readFileSync(path);
  return { raw: bytes.byteLength, gzip: gzipSync(bytes).byteLength };
}

let files;
try {
  files = walk(distDir).map((path) => relative(distDir, path));
} catch {
  console.error(`report-payload: no build output at "${distDir}" — run \`npm run build\` first.`);
  process.exit(1);
}

const html = readFileSync(join(distDir, ENTRY_HTML), 'utf8');

/**
 * Render-blocking assets: whatever the entry HTML names in a `src`/`href`.
 *
 * A `<script type="module">` is deferred but still fetched and executed before
 * the app can draw, so it counts. Anything reached only through a dynamic
 * `import()` or a loader at runtime does not appear here — which is exactly
 * the distinction being measured.
 */
const referenced = new Set([ENTRY_HTML]);
for (const [, url] of html.matchAll(/(?:src|href)\s*=\s*["']([^"']+)["']/g)) {
  if (/^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(url)) continue; // data:, https:, //cdn, #frag
  const name = url.replace(/^\.?\//, '').replace(/^babbage-clock\//, '');
  if (files.includes(name)) referenced.add(name);
}

const isSourceMap = (name) => name.endsWith('.map');
const firstLoad = files.filter((name) => referenced.has(name) && !isSourceMap(name)).sort();
const deferred = files.filter((name) => !referenced.has(name) && !isSourceMap(name)).sort();
const sourceMaps = files.filter(isSourceMap);

const total = (names) =>
  names.reduce(
    (sum, name) => {
      const { raw, gzip } = measure(join(distDir, name));
      return { raw: sum.raw + raw, gzip: sum.gzip + gzip };
    },
    { raw: 0, gzip: 0 },
  );

const firstLoadTotal = total(firstLoad);
const deferredTotal = total(deferred);
const sourceMapTotal = total(sourceMaps);

const lines = [];
lines.push('## First-load payload', '');
lines.push('| Asset | Raw | Gzipped | Hashed |', '| --- | ---: | ---: | :---: |');
for (const name of firstLoad) {
  const { raw, gzip } = measure(join(distDir, name));
  const hashed = /-[A-Za-z0-9_-]{8,}\.[a-z0-9]+$/.test(name) ? 'yes' : 'no';
  lines.push(`| \`${name}\` | ${kb(raw)} | ${kb(gzip)} | ${hashed} |`);
}
lines.push(`| **Total** | **${kb(firstLoadTotal.raw)}** | **${kb(firstLoadTotal.gzip)}** | |`, '');

lines.push(
  deferred.length === 0
    ? '_No deferred assets: everything shipped is on the first-load path._'
    : `### Deferred (not fetched before first paint) — ${deferred.length} file(s), ${kb(deferredTotal.raw)} raw`,
  '',
);
for (const name of deferred) {
  const { raw } = measure(join(distDir, name));
  lines.push(`- \`${name}\` — ${kb(raw)}`);
}
if (deferred.length > 0) lines.push('');

lines.push(
  `_Source maps excluded from the totals above (${sourceMaps.length} file(s), ${kb(sourceMapTotal.raw)} raw): browsers fetch them only with devtools open._`,
);

console.log(lines.join('\n'));
