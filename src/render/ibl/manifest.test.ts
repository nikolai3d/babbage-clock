import { readFileSync, readdirSync, statSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { IblManifestError, parseHexColor, parseIblManifest } from './manifest.js';
import { ENVIRONMENT_PRESETS } from '../../scene/environment.js';
import { isFixturePreset } from './presets.js';

/**
 * Resolved from this module rather than from the working directory, so the
 * tests find the assets whichever directory Vitest is launched from.
 */
const IBL_ROOT = new URL('../../../assets/ibl/', import.meta.url);

function inPreset(folder: string, file: string): URL {
  return new URL(`${folder}/${file}`, IBL_ROOT);
}

/** The smallest manifest that is still valid, as a base for focused edits. */
function minimal(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'test',
    name: 'Test',
    environment: { file: 'a.hdr', format: 'rgbe', intensity: 1, rotation: 0 },
    background: { mode: 'environment', fallback: { kind: 'color', color: '#101010' } },
    grade: { exposure: 1, toneMapping: 'aces' },
    lights: [],
    source: {
      title: 'T',
      authors: ['A'],
      provider: 'P',
      url: 'https://example.invalid',
      licence: 'CC0-1.0',
    },
    ...overrides,
  };
}

describe('parseIblManifest', () => {
  it('fills in every optional field so nothing downstream re-applies a default', () => {
    const manifest = parseIblManifest(minimal(), 'test');

    expect(manifest.description).toBe('');
    expect(manifest.fog).toBeNull();
    expect(manifest.sceneLightScale).toBe(0);
    expect(manifest.background.blurriness).toBe(0);
    expect(manifest.background.intensity).toBe(1);
  });

  it('parses "#rrggbb" colours into the numbers three.js wants', () => {
    expect(parseHexColor('#ff8000')).toBe(0xff8000);
    expect(parseHexColor('ff8000')).toBe(0xff8000);
    expect(parseHexColor('#fff')).toBeNull();
    expect(parseHexColor(0xff8000)).toBeNull();
  });

  it('reports every problem at once rather than failing on the first', () => {
    let error: unknown;
    try {
      parseIblManifest({ environment: {}, background: {}, grade: {} }, 'broken.json');
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(IblManifestError);
    const problems = (error as IblManifestError).problems;
    expect(problems.some((p) => p.startsWith('id'))).toBe(true);
    expect(problems.some((p) => p.startsWith('name'))).toBe(true);
    expect(problems.some((p) => p.startsWith('environment.file'))).toBe(true);
    expect(problems.some((p) => p.startsWith('source'))).toBe(true);
    expect((error as IblManifestError).message).toContain('broken.json');
  });

  it('rejects an unsupported panorama format and tone-mapping curve', () => {
    expect(() =>
      parseIblManifest(minimal({ environment: { file: 'a.png', format: 'png' } }), 'test'),
    ).toThrow(/environment\.format/);

    expect(() =>
      parseIblManifest(minimal({ grade: { exposure: 1, toneMapping: 'filmic' } }), 'test'),
    ).toThrow(/grade\.toneMapping/);
  });

  it('rejects a scene-light scale outside [0, 1] and a non-positive exposure', () => {
    expect(() => parseIblManifest(minimal({ sceneLightScale: 1.5 }), 'test')).toThrow(
      /sceneLightScale/,
    );
    expect(() => parseIblManifest(minimal({ grade: { exposure: 0 } }), 'test')).toThrow(
      /grade\.exposure/,
    );
  });

  it('rejects fog whose far plane does not exceed its near plane', () => {
    expect(() =>
      parseIblManifest(minimal({ fog: { color: '#000000', near: 20, far: 5 } }), 'test'),
    ).toThrow(/fog\.far/);
  });

  it('parses every light type the rig supports', () => {
    const manifest = parseIblManifest(
      minimal({
        lights: [
          { type: 'ambient', color: '#ffffff', intensity: 0.2 },
          { type: 'hemisphere', color: '#ffffff', groundColor: '#202020' },
          { type: 'directional', color: '#ffffff', position: [1, 2, 3] },
          { type: 'point', color: '#ffffff', position: [1, 2, 3], distance: 10 },
          { type: 'spot', color: '#ffffff', position: [1, 2, 3], target: [0, 0, 0] },
        ],
      }),
      'test',
    );

    expect(manifest.lights.map((light) => light.type)).toEqual([
      'ambient',
      'hemisphere',
      'directional',
      'point',
      'spot',
    ]);
    // Defaults that keep a manifest terse: inverse-square falloff, and a name
    // derived from the index when the author did not give one.
    const point = manifest.lights[3]!;
    expect(point.type === 'point' && point.decay).toBe(2);
    expect(manifest.lights[0]!.name).toBe('light-0');
  });

  it('names the light that is wrong, not just "a light"', () => {
    expect(() =>
      parseIblManifest(minimal({ lights: [{ type: 'directional', color: '#ffffff' }] }), 'test'),
    ).toThrow(/lights\[0\]\.position/);
  });

  it('parses a directional shadow block and defaults its acne counters', () => {
    const manifest = parseIblManifest(
      minimal({
        lights: [
          { type: 'directional', color: '#ffffff', position: [1, 2, 3], shadow: { radius: 7 } },
          { type: 'directional', color: '#ffffff', position: [3, 2, 1] },
        ],
      }),
      'test',
    );

    const [casting, plain] = manifest.lights;
    expect(casting?.type === 'directional' && casting.shadow).toEqual({
      radius: 7,
      near: 0.5,
      far: 50,
      bias: -0.0002,
      normalBias: 0.02,
    });
    // No block means no key at all — downstream reads `spec.shadow` truthily.
    expect(plain?.type === 'directional' && 'shadow' in plain).toBe(false);
  });

  it('rejects a shadow block without a usable frustum', () => {
    const withShadow = (shadow: unknown): Record<string, unknown> =>
      minimal({ lights: [{ type: 'directional', color: '#ffffff', position: [1, 2, 3], shadow }] });

    // A guessed radius is either clipped or blocky, so it is not defaulted.
    expect(() => parseIblManifest(withShadow({}), 'test')).toThrow(/lights\[0\]\.shadow\.radius/);
    expect(() => parseIblManifest(withShadow({ radius: -1 }), 'test')).toThrow(
      /lights\[0\]\.shadow\.radius/,
    );
    expect(() => parseIblManifest(withShadow({ radius: 5, near: 6, far: 2 }), 'test')).toThrow(
      /lights\[0\]\.shadow\.far/,
    );
  });

  it('defaults a missing fallback backdrop to black rather than to nothing', () => {
    // A scene may set `showAsBackground: false` under any mood, so every mood
    // needs a backdrop even if its own manifest never mentions one.
    const manifest = parseIblManifest(minimal({ background: { mode: 'environment' } }), 'test');
    expect(manifest.background.fallback).toEqual({ kind: 'color', color: 0x000000 });
  });
});

/**
 * Folders prefixed `test-` are CI fixtures, not moods: committed so a decode
 * path (today: KTX2/UASTC-HDR) can be exercised end to end in a browser, and
 * deliberately kept out of the picker and of `?mood=`. They get their own
 * describe below with fixture-sized expectations. The `test-` prefix convention
 * lives with discovery in `presets.ts` (`isFixturePreset`); this suite consumes
 * it rather than re-deriving it.
 */

// One folder per mood or fixture, plus `LICENSES.md`, which is neither.
const allFolders = readdirSync(IBL_ROOT).filter((entry) =>
  statSync(new URL(entry, IBL_ROOT)).isDirectory(),
);

function manifestFor(folder: string): ReturnType<typeof parseIblManifest> {
  const path = inPreset(folder, 'preset.json');
  return parseIblManifest(JSON.parse(readFileSync(path, 'utf8')) as unknown, String(path));
}

/**
 * Content tests. The five shipped moods are data, and data can be wrong in ways
 * a type cannot catch — a renamed HDR, a missing licence, an id that no longer
 * matches its folder. These run against the real files in `assets/ibl/`.
 */
describe('the shipped IBL presets', () => {
  const folders = allFolders.filter((folder) => !isFixturePreset(folder));

  it('covers every mood the picker offers except "none"', () => {
    const offered = ENVIRONMENT_PRESETS.map((preset) => preset.id).filter((id) => id !== 'none');
    expect([...folders].sort()).toEqual([...offered].sort());
  });

  for (const folder of folders) {
    it(`${folder}: parses, and its id matches its folder`, () => {
      const manifest = manifestFor(folder);

      expect(manifest.id).toBe(folder);
      expect(manifest.name).not.toBe('');
      expect(manifest.description).not.toBe('');
    });
  }

  for (const folder of folders) {
    it(`${folder}: names a panorama that exists and is a real HDR`, () => {
      const manifest = manifestFor(folder);
      const panorama = inPreset(folder, manifest.environment.file);

      // `#?RADIANCE` is the Radiance HDR magic. A 404 saved to disk as an HTML
      // error page would pass a size check and fail here.
      expect(readFileSync(panorama).subarray(0, 10).toString('ascii')).toBe('#?RADIANCE');
    });
  }

  for (const folder of folders) {
    it(`${folder}: keeps its payload inside the 3 MB budget`, () => {
      const manifest = manifestFor(folder);
      const bytes = statSync(inPreset(folder, manifest.environment.file)).size;

      expect(bytes).toBeGreaterThan(64 * 1024);
      expect(bytes).toBeLessThan(3 * 1024 * 1024);
    });
  }

  for (const folder of folders) {
    it(`${folder}: records where its panorama came from and under what licence`, () => {
      const manifest = manifestFor(folder);

      expect(manifest.source.authors.length).toBeGreaterThan(0);
      expect(manifest.source.licence).toMatch(/CC0/);
      expect(manifest.source.url).toMatch(/^https:\/\//);
    });
  }

  for (const folder of folders) {
    it(`${folder}: ships a light rig to complement the map`, () => {
      const manifest = manifestFor(folder);

      // IBL alone has almost no shadow definition; the rig is not optional, and
      // a mood that hands lighting to its rig must actually have one.
      expect(manifest.lights.length).toBeGreaterThanOrEqual(2);
      if (manifest.sceneLightScale === 0) expect(manifest.lights.length).toBeGreaterThan(0);
    });
  }
});

describe('the IBL CI fixtures', () => {
  const fixtures = allFolders.filter((folder) => isFixturePreset(folder));

  it('include the UASTC-HDR fixture the compressed-path e2e depends on', () => {
    // `e2e/ibl.spec.ts` boots the app with `?moodOverride=test-uastc-hdr`; if
    // the folder is renamed or dropped, fail here — in the unit suite, with a
    // message that names the dependency — rather than as a mood-load timeout.
    expect(fixtures).toContain('test-uastc-hdr');
  });

  it('never leak into the picker', () => {
    // A fixture is committed to be asserted on, not looked at: the picker (and
    // with it `?mood=` and share links) must not know these folders exist.
    for (const preset of ENVIRONMENT_PRESETS) {
      expect(isFixturePreset(preset.id)).toBe(false);
    }
  });

  for (const folder of fixtures) {
    it(`${folder}: parses, and its id matches its folder`, () => {
      expect(manifestFor(folder).id).toBe(folder);
    });
  }

  for (const folder of fixtures) {
    it(`${folder}: records where its panorama came from and under what licence`, () => {
      const manifest = manifestFor(folder);

      // Same provenance bar as a shipped mood, minus the CC0 requirement: a
      // fixture is never redistributed as content, so any auditable licence
      // (the three.js sample is MIT) is acceptable.
      expect(manifest.source.authors.length).toBeGreaterThan(0);
      expect(manifest.source.licence).not.toBe('');
      expect(manifest.source.url).toMatch(/^https:\/\//);
    });
  }

  for (const folder of fixtures) {
    it(`${folder}: stays fixture-sized`, () => {
      const manifest = manifestFor(folder);
      const bytes = statSync(inPreset(folder, manifest.environment.file)).size;

      // Fixtures ride along in the production bundle listing (the preset glob
      // cannot tell them apart), so they must cost next to nothing. The lower
      // bound is the one that matters for a *future* fixture: a zero-byte or
      // truncated file would otherwise sail through "small enough".
      expect(bytes).toBeGreaterThan(256);
      expect(bytes).toBeLessThan(16 * 1024);
    });
  }

  // Looped rather than written against `test-uastc-hdr` alone: losing the
  // format check is exactly how a fixture silently stops exercising the path
  // it was committed for, so any `.ktx2` fixture added later inherits it.
  for (const folder of fixtures.filter((f) => manifestFor(f).environment.format === 'ktx2')) {
    it(`${folder}: is a genuine Basis UASTC HDR container`, () => {
      const manifest = manifestFor(folder);
      const bytes = readFileSync(inPreset(folder, manifest.environment.file));

      // The KTX 2.0 identifier — a truncated download or an HTML error page
      // saved to disk would fail here before it failed in a browser.
      expect(bytes.subarray(0, 12).toString('hex')).toBe('ab4b5458203230bb0d0a1a0a');

      // three.js routes a file through the Basis wasm transcoder when
      // `vkFormat === VK_FORMAT_ASTC_4x4_SFLOAT_BLOCK_EXT && colorModel ===
      // 0xA7` and the GPU lacks native ASTC HDR (KTX2Loader's `isBasisHDR`).
      // Both halves are pinned: a replacement fixture satisfying only one of
      // them would quietly take a different branch and stop exercising the
      // transcoder that `e2e/ibl.spec.ts` exists to run.
      expect(bytes.readUInt32LE(12)).toBe(1000066000);

      // The colour model is the low byte of the descriptor word at DFD offset
      // 12 (4 bytes of dfdTotalSize, then 8 into the descriptor block).
      const dfdByteOffset = bytes.readUInt32LE(48);
      const colorModel = bytes.readUInt32LE(dfdByteOffset + 12) & 0xff;
      expect(colorModel).toBe(0xa7);
    });
  }
});
