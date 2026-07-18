#!/usr/bin/env node
/**
 * Copies the KTX2/BasisU transcoder out of `three` into `public/basis/`.
 *
 * `KTX2Loader` fetches its transcoder at runtime rather than importing it, so
 * the files have to be *served*, not bundled — and being fetched at runtime,
 * they get no base-path rewriting from Vite either. `public/` solves both:
 * Vite copies it verbatim into `dist/`, and `src/materials/paths.ts` joins the
 * URL onto `import.meta.env.BASE_URL` so a deployment under `/babbage-clock/`
 * resolves it correctly.
 *
 * Copied at build time rather than committed: they are 580 kB of somebody
 * else's binary, they are already an exact function of the installed `three`
 * version, and a stale committed copy against a newer `three` is a bug that
 * only appears in production.
 *
 * Wired to `predev` and `prebuild`, so nobody has to remember it.
 */

import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DESTINATION = join(ROOT, 'public', 'basis');
const FILES = ['basis_transcoder.js', 'basis_transcoder.wasm'];

const require = createRequire(import.meta.url);

function transcoderSource() {
  // Resolved through `three` itself rather than a guessed path, so a hoisted
  // install — or this repository's agent worktrees, which resolve up to the
  // parent checkout — still finds it. `three` does not export its
  // `package.json`, so the package root is found by walking up from the
  // resolved entry point instead.
  let directory;
  try {
    directory = dirname(require.resolve('three'));
  } catch {
    return null;
  }

  for (let depth = 0; depth < 5; depth += 1) {
    const candidate = join(directory, 'examples', 'jsm', 'libs', 'basis');
    if (existsSync(candidate)) return candidate;
    directory = dirname(directory);
  }
  return null;
}

const source = transcoderSource();
if (!source || !FILES.every((file) => existsSync(join(source, file)))) {
  // Not fatal. Without the transcoder the loader falls back to the
  // uncompressed maps every manifest is required to list, so the app still
  // renders — it just downloads more.
  console.warn('[basis] transcoder not found in three; KTX2 maps will fall back to PNG/JPG');
  process.exit(0);
}

mkdirSync(DESTINATION, { recursive: true });
for (const file of FILES) copyFileSync(join(source, file), join(DESTINATION, file));
console.log(`[basis] transcoder synced to public/basis/ (${FILES.join(', ')})`);
