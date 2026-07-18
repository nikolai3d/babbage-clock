#!/usr/bin/env node
/**
 * Batch-compresses a dropped-in material folder to KTX2/BasisU.
 *
 *   npm run materials:compress -- copper-plate
 *   npm run materials:compress -- --all
 *
 * For each map listed in `material.json` it writes a sibling `.ktx2` and adds
 * it to the manifest, leaving the original in place: the manifest lists both,
 * and the loader picks the compressed one only where a transcoder actually
 * runs. Nothing is lost if the artist's browser cannot transcode.
 *
 * Two things this gets right that a hand-rolled `toktx` invocation usually
 * does not:
 *
 * - **Colour space per map.** Base colour and emissive are encoded as sRGB;
 *   roughness, metalness, occlusion, height and normals are encoded as linear
 *   data. Getting this wrong bakes a gamma curve into a roughness map, and the
 *   result looks "a bit off" in a way nobody can pin down.
 * - **Orientation.** A KTX2 payload cannot be flipped at load time the way a
 *   PNG can, so the flip is baked in here to match `flipY = true` on the
 *   uncompressed path. Otherwise swapping a material to its compressed twin
 *   turns the texture upside down.
 *
 * Requires `toktx` from the KTX-Software toolkit:
 *   brew install ktx  |  https://github.com/KhronosGroup/KTX-Software/releases
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const MATERIALS = join(ROOT, 'public', 'assets', 'materials');

/** Channels whose values are colours to be looked at, not data to be sampled. */
const SRGB_CHANNELS = new Set([
  'baseColor',
  'basecolor',
  'albedo',
  'diffuse',
  'emissive',
  'emission',
]);

/** Normal maps need the higher-quality codec; banding there is visible as facets. */
const UASTC_CHANNELS = new Set(['normal', 'normalMap', 'height', 'displacement']);

function haveToktx() {
  try {
    execFileSync('toktx', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function compressFolder(id) {
  const folder = join(MATERIALS, id);
  const manifestPath = join(folder, 'material.json');
  if (!existsSync(manifestPath)) {
    console.error(`  ${id}: no material.json — skipped`);
    return false;
  }

  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const maps = manifest.maps ?? {};
  let changed = false;

  for (const [channel, entry] of Object.entries(maps)) {
    const file = typeof entry === 'string' ? entry : entry.file;
    if (!file) continue;

    const source = join(folder, file);
    if (!existsSync(source)) {
      console.error(`  ${id}/${file}: missing — skipped`);
      continue;
    }

    const target = file.replace(/\.(png|jpg|jpeg)$/i, '.ktx2');
    if (target === file) {
      console.error(`  ${id}/${file}: not a PNG/JPG — skipped`);
      continue;
    }

    const args = [
      '--t2',
      '--genmipmap',
      // Bakes in the same orientation the uncompressed path gets from flipY.
      '--lower_left_maps_to_s0t0',
      ...(SRGB_CHANNELS.has(channel) ? ['--assign_oetf', 'srgb'] : ['--assign_oetf', 'linear']),
      ...(UASTC_CHANNELS.has(channel)
        ? ['--uastc', '2', '--uastc_rdo_l', '1.0', '--zcmp', '18']
        : ['--bcmp', '--clevel', '4', '--qlevel', '192']),
      join(folder, target),
      source,
    ];

    execFileSync('toktx', args, { stdio: 'inherit' });

    maps[channel] = { file, ktx2: target };
    changed = true;
    console.log(`  ${id}/${file} -> ${target}`);
  }

  if (changed) {
    manifest.maps = maps;
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  }
  return changed;
}

const args = process.argv.slice(2);
if (args.length === 0) {
  console.error('usage: npm run materials:compress -- <material-id> | --all');
  process.exit(1);
}

if (!haveToktx()) {
  console.error(
    'toktx not found. Install the KTX-Software toolkit:\n' +
      '  macOS:  brew install ktx\n' +
      '  other:  https://github.com/KhronosGroup/KTX-Software/releases\n\n' +
      'Compression is optional — every manifest lists an uncompressed file too.',
  );
  process.exit(1);
}

const ids = args.includes('--all')
  ? readdirSync(MATERIALS, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
  : args;

let compressed = 0;
for (const id of ids) {
  console.log(id);
  if (compressFolder(id)) compressed += 1;
}
console.log(`\n${compressed}/${ids.length} material folders compressed`);
