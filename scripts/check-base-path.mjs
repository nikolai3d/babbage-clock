#!/usr/bin/env node
/**
 * Fails the build when an asset URL ignores Vite's `base`.
 *
 * Why this exists: the site is served from a *project* page at
 * `/babbage-clock/`, not from a domain root. Vite rewrites every URL it can
 * see — ES module imports, `new URL(..., import.meta.url)`, CSS `url()`, the
 * `<script>`/`<link>` tags in `index.html` — but it cannot see a string that
 * only becomes a URL at runtime. `fetch('/assets/studio.hdr')` survives the
 * build untouched and then 404s in production, on the deployed site only,
 * which is the single most common way a Pages deploy ships broken.
 *
 * The live smoke test catches that too, but only for assets a boot actually
 * requests. This catches the ones behind a lazy path or a scene the smoke run
 * never selects — and it catches them in `npm run ci`, before a PR is opened.
 *
 * The fix in application code is always the same: build the URL from
 * `import.meta.env.BASE_URL`, or better, let the bundler own it —
 * `new URL('../../assets/ibl/studio.hdr', import.meta.url).href`.
 *
 * Usage: `node scripts/check-base-path.mjs [distDir]` (default `dist`).
 * Reads the expected base from `VITE_BASE_PATH`, matching vite.config.ts.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const distDir = process.argv[2] ?? 'dist';
const base = process.env.VITE_BASE_PATH ?? './';
/** A relative base has no legal root-absolute form, hence the empty string. */
const allowedPrefix = base.startsWith('/') ? base : '';

/** Extensions that mean "this string is a URL we ship", not incidental text. */
const ASSET_EXTENSIONS =
  'js|mjs|css|json|wasm|map|png|jpe?g|webp|avif|gif|svg|ico|hdr|exr|ktx2?|basis|glb|gltf|bin|woff2?|ttf|mp4|webm';

/**
 * Root-absolute URLs inside a quoted string or a CSS `url()`.
 *
 * Deliberately narrow. It requires a known asset extension so that shader
 * source, regular expressions and route-ish strings in the vendor bundle do
 * not trip it, and it excludes `//` so protocol-relative URLs to third parties
 * (a CDN, a time-sync provider) are left alone.
 */
const ABSOLUTE_URL = new RegExp(
  String.raw`(?:["'\`]|url\()(\/(?!\/)[^"'\`()\s]*\.(?:${ASSET_EXTENSIONS})(?:[?#][^"'\`()\s]*)?)`,
  'g',
);

/** `src="..."` / `href="..."` in the HTML entry. */
const HTML_ATTRIBUTE = /(?:src|href)\s*=\s*["']([^"']+)["']/g;

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) out.push(...walk(path));
    else out.push(path);
  }
  return out;
}

/** True for URLs that are not ours to rewrite (external, inline, or fragments). */
function isExternal(url) {
  return /^(?:[a-z][a-z0-9+.-]*:|\/\/|#|\?)/i.test(url);
}

function lineOf(text, index) {
  return text.slice(0, index).split('\n').length;
}

let files;
try {
  files = walk(distDir);
} catch {
  console.error(`check-base-path: no build output at "${distDir}" — run \`npm run build\` first.`);
  process.exit(1);
}

const problems = [];

for (const file of files) {
  const relativePath = relative(process.cwd(), file);

  if (file.endsWith('.html')) {
    const text = readFileSync(file, 'utf8');
    for (const match of text.matchAll(HTML_ATTRIBUTE)) {
      const url = match[1];
      if (isExternal(url) || !url.startsWith('/')) continue;
      if (allowedPrefix !== '' && url.startsWith(allowedPrefix)) continue;
      problems.push(`${relativePath}:${lineOf(text, match.index)} — <… ${match[0]}>`);
    }
    continue;
  }

  // Source maps embed the original module text, where a root-absolute string
  // in a comment or an unminified branch is not evidence of a shipped URL.
  if (!/\.(?:js|mjs|css)$/.test(file)) continue;

  const text = readFileSync(file, 'utf8');
  for (const match of text.matchAll(ABSOLUTE_URL)) {
    const url = match[1];
    if (allowedPrefix !== '' && url.startsWith(allowedPrefix)) continue;
    problems.push(`${relativePath}:${lineOf(text, match.index)} — ${url}`);
  }
}

if (problems.length > 0) {
  const expected = allowedPrefix === '' ? `relative to base "${base}"` : `under "${allowedPrefix}"`;
  console.error(
    `check-base-path: ${problems.length} asset URL(s) bypass the site base — they must be ${expected}:\n`,
  );
  for (const problem of problems) console.error(`  ${problem}`);
  console.error(
    '\nRoot-absolute URLs 404 on a project page. Derive runtime URLs from\n' +
      "`import.meta.env.BASE_URL`, or from `new URL('…', import.meta.url)` so the\n" +
      'bundler rewrites and hashes them. See docs/deploy.md.',
  );
  process.exit(1);
}

console.log(`check-base-path: ${files.length} built file(s) OK for base "${base}".`);
