import { readFileSync, readdirSync, statSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { IblManifestError, parseHexColor, parseIblManifest } from './manifest.js';
import { ENVIRONMENT_PRESETS } from '../../scene/environment.js';

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

  it('defaults a missing fallback backdrop to black rather than to nothing', () => {
    // A scene may set `showAsBackground: false` under any mood, so every mood
    // needs a backdrop even if its own manifest never mentions one.
    const manifest = parseIblManifest(minimal({ background: { mode: 'environment' } }), 'test');
    expect(manifest.background.fallback).toEqual({ kind: 'color', color: 0x000000 });
  });
});

/**
 * Content tests. The five shipped moods are data, and data can be wrong in ways
 * a type cannot catch — a renamed HDR, a missing licence, an id that no longer
 * matches its folder. These run against the real files in `assets/ibl/`.
 */
describe('the shipped IBL presets', () => {
  // One folder per mood, plus `LICENSES.md`, which is not one.
  const folders = readdirSync(IBL_ROOT).filter((entry) =>
    statSync(new URL(entry, IBL_ROOT)).isDirectory(),
  );

  function manifestFor(folder: string): ReturnType<typeof parseIblManifest> {
    const path = inPreset(folder, 'preset.json');
    return parseIblManifest(JSON.parse(readFileSync(path, 'utf8')) as unknown, String(path));
  }

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
