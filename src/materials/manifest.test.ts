import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SCALARS,
  MaterialManifestError,
  colorSpaceForChannel,
  hasTextures,
  parseMaterialManifest,
  requiredMaps,
  sourceForSlot,
} from './manifest.js';

/**
 * The manifest is the contract between an artist's export and the renderer, so
 * these tests are about what an artist can and cannot get wrong.
 */

const minimal = { maps: { baseColor: 'basecolor.png' } };

describe('parseMaterialManifest', () => {
  it('defaults everything a minimal manifest leaves out', () => {
    const manifest = parseMaterialManifest(minimal, 'plain');

    expect(manifest.id).toBe('plain');
    expect(manifest.name).toBe('plain');
    expect(manifest.tiling).toEqual([1, 1]);
    expect(manifest.offset).toEqual([0, 0]);
    expect(manifest.normal).toEqual({ convention: 'opengl', scale: 1 });
    expect(manifest.scalars).toEqual(DEFAULT_SCALARS);
    expect(manifest.physical).toEqual({});
  });

  it('accepts a folder with no maps at all', () => {
    const manifest = parseMaterialManifest(
      { scalars: { baseColor: '#241a12', roughness: 0.62 } },
      'enamel',
    );

    expect(hasTextures(manifest)).toBe(false);
    expect(requiredMaps(manifest)).toEqual([]);
    expect(manifest.scalars.roughness).toBe(0.62);
    // Untouched scalars still come through, so the material is fully defined.
    expect(manifest.scalars.metalness).toBe(DEFAULT_SCALARS.metalness);
  });

  it('accepts the spellings Sampler and the wider world actually use', () => {
    const manifest = parseMaterialManifest(
      {
        maps: {
          basecolor: 'a.png',
          metallic: 'b.png',
          ambientOcclusion: 'c.png',
          emission: 'd.png',
        },
      },
      'aliases',
    );

    expect(manifest.maps.baseColor?.file).toBe('a.png');
    expect(manifest.maps.metalness?.file).toBe('b.png');
    expect(manifest.maps.ao?.file).toBe('c.png');
    expect(manifest.maps.emissive?.file).toBe('d.png');
  });

  it('reports a typo rather than silently ignoring the map', () => {
    expect(() => parseMaterialManifest({ maps: { rougness: 'r.png' } }, 'typo')).toThrow(
      /unknown map channel "rougness"/,
    );
  });

  it('lists every problem at once', () => {
    let error: unknown;
    try {
      parseMaterialManifest(
        {
          maps: { baseColor: '' },
          tiling: 'lots',
          normal: { convention: 'gl' },
          scalars: { roughness: 4 },
          physical: { glitter: 1 },
        },
        'broken',
      );
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(MaterialManifestError);
    const problems = (error as MaterialManifestError).problems;
    expect(problems).toHaveLength(5);
    expect(problems.join('\n')).toMatch(/roughness must be <= 1/);
    expect(problems.join('\n')).toMatch(/unknown physical property "glitter"/);
  });

  it('reads colours as hex strings or numbers', () => {
    const fromString = parseMaterialManifest({ scalars: { baseColor: '#b87333' } }, 'a');
    const fromNumber = parseMaterialManifest({ scalars: { baseColor: 0xb87333 } }, 'b');

    expect(fromString.scalars.baseColor).toBe(0xb87333);
    expect(fromNumber.scalars.baseColor).toBe(0xb87333);
  });

  it('takes a single number as uniform tiling', () => {
    expect(parseMaterialManifest({ tiling: 3 }, 'a').tiling).toEqual([3, 3]);
  });

  it('carries a KTX2 alternative alongside the uncompressed file', () => {
    const manifest = parseMaterialManifest(
      { maps: { baseColor: { file: 'basecolor.png', ktx2: 'basecolor.ktx2' } } },
      'compressed',
    );

    expect(manifest.maps.baseColor).toMatchObject({
      file: 'basecolor.png',
      ktx2: 'basecolor.ktx2',
    });
  });
});

describe('colour space', () => {
  /**
   * The single most common way a PBR pipeline ships subtly wrong. It is a
   * property of the channel, never a manifest field, so there is nothing to get
   * wrong and nothing to argue with.
   */
  it('decodes only base colour and emissive', () => {
    expect(colorSpaceForChannel('baseColor')).toBe('srgb');
    expect(colorSpaceForChannel('emissive')).toBe('srgb');

    for (const channel of ['normal', 'orm', 'roughness', 'metalness', 'ao', 'height'] as const) {
      expect(colorSpaceForChannel(channel)).toBe('linear');
    }
  });

  it('cannot be overridden from the manifest', () => {
    expect(() =>
      parseMaterialManifest({ maps: { baseColor: 'a.png' }, colorSpace: 'linear' }, 'sneaky'),
    ).toThrow(/unknown manifest key "colorSpace"/);
  });
});

describe('channel packing', () => {
  const packed = parseMaterialManifest({ maps: { baseColor: 'c.png', orm: 'orm.png' } }, 'packed');
  const separate = parseMaterialManifest(
    { maps: { roughness: 'r.png', metallic: 'm.png', ao: 'ao.png' } },
    'separate',
  );

  it('feeds all three slots from one ORM map', () => {
    for (const slot of ['roughness', 'metalness', 'ao'] as const) {
      expect(sourceForSlot(packed, slot)?.file).toBe('orm.png');
    }
    // One file, one download, however many slots read from it.
    expect(requiredMaps(packed).map((source) => source.file)).toEqual(['c.png', 'orm.png']);
  });

  it('uses separate maps when they are exported that way', () => {
    expect(sourceForSlot(separate, 'roughness')?.file).toBe('r.png');
    expect(sourceForSlot(separate, 'metalness')?.file).toBe('m.png');
    expect(sourceForSlot(separate, 'ao')?.file).toBe('ao.png');
  });

  it('lets a hand-tweaked separate map win over the packed one', () => {
    const both = parseMaterialManifest(
      { maps: { orm: 'orm.png', roughness: 'rough-tweaked.png' } },
      'both',
    );

    expect(sourceForSlot(both, 'roughness')?.file).toBe('rough-tweaked.png');
    expect(sourceForSlot(both, 'metalness')?.file).toBe('orm.png');
  });
});

describe('requiredMaps', () => {
  it('skips the height map unless displacement was actually asked for', () => {
    const idle = parseMaterialManifest({ maps: { height: 'h.png' } }, 'idle');
    const used = parseMaterialManifest(
      { maps: { height: 'h.png' }, scalars: { displacementScale: 0.01 } },
      'used',
    );

    expect(requiredMaps(idle)).toEqual([]);
    expect(requiredMaps(used).map((source) => source.file)).toEqual(['h.png']);
  });
});
