import * as THREE from 'three';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MaterialLibrary } from './materials.js';
import { MaterialRegistry } from './materialRegistry.js';
import { copperPadlockScene } from '../scene/scenes/copperPadlock.js';
import { MATERIAL_SLOTS } from '../scene/types.js';
import type { MaterialSlotMap } from '../scene/types.js';

/**
 * The material pipeline, exercised end to end against in-memory folders.
 *
 * No WebGL context is needed: everything asserted here — colour space, channel
 * packing, scalar fallbacks, reference counting — is decided on the CPU before
 * a single byte reaches the GPU, which is precisely why it can be tested at
 * all. The pixels themselves are the screenshot suite's job.
 */

const FOLDERS: Record<string, unknown> = {
  'copper-plate': {
    maps: { baseColor: 'basecolor.png', normal: 'normal.png', orm: 'orm.png' },
    tiling: [1, 1],
    scalars: { baseColor: '#b87333', metalness: 1, roughness: 0.38 },
    physical: { clearcoat: 0.08 },
  },
  'blued-steel': {
    maps: {
      baseColor: 'basecolor.png',
      normal: 'normal.png',
      roughness: 'roughness.png',
      metallic: 'metallic.png',
      ambientOcclusion: 'ao.png',
    },
    normal: { convention: 'directx', scale: 0.7 },
    tiling: [2, 2],
    scalars: { baseColor: '#3d4756', metalness: 1, roughness: 0.3 },
  },
  'dark-enamel': {
    scalars: { baseColor: '#241a12', metalness: 0.08, roughness: 0.62 },
  },
};

interface Harness {
  registry: MaterialRegistry;
  /** Every texture URL that was actually requested, in order. */
  readonly loads: string[];
  readonly fetches: string[];
}

function harness(): Harness {
  const loads: string[] = [];
  const fetches: string[] = [];

  const registry = new MaterialRegistry({
    baseUrl: '/base/',
    fetchImpl: ((input: string) => {
      const url = input;
      fetches.push(url);
      const id = url.replace('/base/assets/materials/', '').replace('/material.json', '');
      const body = FOLDERS[id];
      if (!body) {
        return Promise.resolve(new Response('not found', { status: 404 }));
      }
      return Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));
    }) as unknown as typeof fetch,
    loadTexture: (url: string) => {
      loads.push(url);
      const texture = new THREE.Texture();
      texture.name = url;
      return Promise.resolve(texture);
    },
  });

  return { registry, loads, fetches };
}

function slots(overrides: Partial<MaterialSlotMap> = {}): MaterialSlotMap {
  const base = Object.fromEntries(
    MATERIAL_SLOTS.map((slot) => [
      slot,
      { kind: 'placeholder', color: 0x808080, metalness: 0, roughness: 1 },
    ]),
  ) as MaterialSlotMap;
  return { ...base, ...overrides };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('colour space', () => {
  /**
   * The failure this prevents is a washed-out, milky clock: an albedo decoded
   * twice, or a roughness map decoded once when it should never have been. It
   * is not visible in a diff and it is not visible in a code review, so it is
   * asserted here.
   */
  it('decodes base colour and leaves data maps alone', async () => {
    const { registry } = harness();
    const library = new MaterialLibrary(
      slots({ housing: { kind: 'pbr', textureSet: 'copper-plate' } }),
      registry,
    );
    await library.ready();

    const material = library.get('housing');
    expect(material.map?.colorSpace).toBe(THREE.SRGBColorSpace);
    expect(material.normalMap?.colorSpace).toBe(THREE.NoColorSpace);
    expect(material.roughnessMap?.colorSpace).toBe(THREE.NoColorSpace);
    expect(material.metalnessMap?.colorSpace).toBe(THREE.NoColorSpace);
    expect(material.aoMap?.colorSpace).toBe(THREE.NoColorSpace);

    library.dispose();
    registry.dispose();
  });

  /**
   * A baked base-colour map already *is* the albedo. Leaving the material's own
   * tint on top of it multiplies the material by its own colour twice, which
   * reads as "the copper went dark" and gets fixed by brightening the light,
   * which then blows out everything else.
   */
  it('drops the tint when a base colour map is present, and keeps it when not', async () => {
    const { registry } = harness();
    const library = new MaterialLibrary(
      slots({
        housing: { kind: 'pbr', textureSet: 'copper-plate' },
        numerals: { kind: 'pbr', textureSet: 'dark-enamel' },
      }),
      registry,
    );
    await library.ready();

    expect(library.get('housing').color.getHex()).toBe(0xffffff);
    expect(library.get('numerals').color.getHex()).toBe(0x241a12);

    library.dispose();
    registry.dispose();
  });
});

describe('channel packing', () => {
  it('feeds roughness, metalness and occlusion from one ORM map', async () => {
    const { registry, loads } = harness();
    const library = new MaterialLibrary(
      slots({ ring: { kind: 'pbr', textureSet: 'copper-plate' } }),
      registry,
    );
    await library.ready();

    const material = library.get('ring');
    expect(material.roughnessMap).toBe(material.metalnessMap);
    expect(material.aoMap).toBe(material.roughnessMap);
    expect(material.roughnessMap?.name).toContain('orm.png');
    // Three slots, one download.
    expect(loads.filter((url) => url.endsWith('orm.png'))).toHaveLength(1);

    library.dispose();
    registry.dispose();
  });

  it('reads separate roughness/metallic/occlusion maps when exported that way', async () => {
    const { registry } = harness();
    const library = new MaterialLibrary(
      slots({ arbor: { kind: 'pbr', textureSet: 'blued-steel' } }),
      registry,
    );
    await library.ready();

    const material = library.get('arbor');
    expect(material.roughnessMap?.name).toContain('roughness.png');
    expect(material.metalnessMap?.name).toContain('metallic.png');
    expect(material.aoMap?.name).toContain('ao.png');
    expect(material.roughnessMap).not.toBe(material.metalnessMap);

    library.dispose();
    registry.dispose();
  });
});

describe('normal maps', () => {
  it('flips a DirectX export back to the OpenGL convention', async () => {
    const { registry } = harness();
    const library = new MaterialLibrary(
      slots({
        housing: { kind: 'pbr', textureSet: 'copper-plate' },
        arbor: { kind: 'pbr', textureSet: 'blued-steel' },
      }),
      registry,
    );
    await library.ready();

    // OpenGL: both components positive.
    expect(library.get('housing').normalScale.toArray()).toEqual([1, 1]);
    // DirectX: green inverted, at the authored strength.
    expect(library.get('arbor').normalScale.toArray()).toEqual([0.7, -0.7]);

    library.dispose();
    registry.dispose();
  });
});

describe('scalar fallbacks', () => {
  it('renders a folder with no maps at all, without a request or a warning', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { registry, loads } = harness();
    const library = new MaterialLibrary(
      slots({ numerals: { kind: 'pbr', textureSet: 'dark-enamel' } }),
      registry,
    );
    await library.ready();

    const material = library.get('numerals');
    expect(material.map).toBeNull();
    expect(material.color.getHex()).toBe(0x241a12);
    expect(material.roughness).toBeCloseTo(0.62);
    expect(material.metalness).toBeCloseTo(0.08);
    expect(loads).toEqual([]);
    expect(warn).not.toHaveBeenCalled();

    library.dispose();
    registry.dispose();
  });

  /**
   * `PbrMaterialBinding` documents its roughness/metalness as multipliers over
   * the authored maps, so a scene can dull one part without a second folder.
   * With no map to multiply they stand in for the manifest scalar instead.
   */
  it('treats a scene override as a multiplier over a map and a value without one', async () => {
    const { registry } = harness();
    const library = new MaterialLibrary(
      slots({
        housing: { kind: 'pbr', textureSet: 'copper-plate', roughness: 1.1 },
        numerals: { kind: 'pbr', textureSet: 'dark-enamel', roughness: 0.2 },
      }),
      registry,
    );
    await library.ready();

    expect(library.get('housing').roughness).toBeCloseTo(1.1);
    expect(library.get('numerals').roughness).toBeCloseTo(0.2);

    library.dispose();
    registry.dispose();
  });

  it('falls back to a neutral surface when the folder is missing', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { registry } = harness();
    const library = new MaterialLibrary(
      slots({ housing: { kind: 'pbr', textureSet: 'nonexistent' } }),
      registry,
    );
    await library.ready();

    // Renders something plausible rather than throwing or going black.
    expect(library.get('housing')).toBeInstanceOf(THREE.MeshPhysicalMaterial);
    expect(library.get('housing').map).toBeNull();
    expect(warn).toHaveBeenCalledOnce();

    library.dispose();
    registry.dispose();
  });
});

describe('tiling', () => {
  it('lets a scene override the manifest per slot, sharing the download', async () => {
    const { registry, loads } = harness();
    const library = new MaterialLibrary(
      slots({
        housing: { kind: 'pbr', textureSet: 'copper-plate' },
        bezel: { kind: 'pbr', textureSet: 'copper-plate', tiling: [4, 4] },
      }),
      registry,
    );
    await library.ready();

    expect(library.get('housing').map?.repeat.toArray()).toEqual([1, 1]);
    expect(library.get('bezel').map?.repeat.toArray()).toEqual([4, 4]);
    // Different laying-on of the same image: one fetch, one decode.
    expect(loads.filter((url) => url.endsWith('basecolor.png'))).toHaveLength(1);

    library.dispose();
    registry.dispose();
  });
});

describe('caching and reference counting', () => {
  it('downloads a folder once however many slots use it', async () => {
    const { registry, loads, fetches } = harness();
    const library = new MaterialLibrary(
      slots({
        housing: { kind: 'pbr', textureSet: 'copper-plate' },
        bezel: { kind: 'pbr', textureSet: 'copper-plate' },
        ring: { kind: 'pbr', textureSet: 'copper-plate' },
      }),
      registry,
    );
    await library.ready();

    expect(fetches.filter((url) => url.includes('copper-plate'))).toHaveLength(1);
    expect(loads).toHaveLength(3);
    // One shared texture per map, not one per slot.
    expect(registry.stats().textures).toBe(3);
    expect(library.get('housing').map).toBe(library.get('ring').map);

    library.dispose();
    registry.dispose();
  });

  /**
   * The leak test. Scene switching and look switching are supported runtime
   * actions, so a reference kept back here would compound every time the viewer
   * changed their mind.
   */
  it('gives every texture back on dispose', async () => {
    const { registry } = harness();
    const library = new MaterialLibrary(
      slots({ housing: { kind: 'pbr', textureSet: 'copper-plate' } }),
      registry,
    );
    await library.ready();
    expect(registry.stats().textures).toBe(3);

    const disposed: string[] = [];
    for (const map of ['map', 'normalMap', 'roughnessMap'] as const) {
      const texture = library.get('housing')[map];
      texture?.addEventListener('dispose', () => disposed.push(map));
    }

    library.dispose();

    expect(registry.stats().textures).toBe(0);
    expect(disposed.sort()).toEqual(['map', 'normalMap', 'roughnessMap']);
    registry.dispose();
  });

  it('survives repeated build/dispose cycles without accumulating textures', async () => {
    const { registry, loads } = harness();

    for (let i = 0; i < 4; i += 1) {
      const library = new MaterialLibrary(
        slots({ ring: { kind: 'pbr', textureSet: 'copper-plate' } }),
        registry,
      );
      await library.ready();
      expect(registry.stats().textures).toBe(3);
      library.dispose();
      expect(registry.stats().textures).toBe(0);
    }

    // The cached decode survives the churn: four scenes, one download.
    expect(loads).toHaveLength(3);
    registry.dispose();
  });
});

describe('hot swap', () => {
  it('rebinds a slot in place, keeping the same material instance', async () => {
    const { registry } = harness();
    const library = new MaterialLibrary(
      slots({ ring: { kind: 'pbr', textureSet: 'copper-plate' } }),
      registry,
    );
    await library.ready();

    const material = library.get('ring');
    const before = material.map;

    library.apply({ ring: { kind: 'pbr', textureSet: 'blued-steel' } });
    await library.ready();

    // Same object — every mesh in the scene is still pointing at it, which is
    // why nothing had to be rebuilt.
    expect(library.get('ring')).toBe(material);
    expect(material.map).not.toBe(before);
    expect(material.map?.name).toContain('blued-steel');

    library.dispose();
    registry.dispose();
  });

  it('releases the outgoing textures and reclaims them on the way back', async () => {
    const { registry } = harness();
    const library = new MaterialLibrary(
      slots({ ring: { kind: 'pbr', textureSet: 'copper-plate' } }),
      registry,
    );
    await library.ready();
    const baseline = registry.stats().textures;

    for (let i = 0; i < 3; i += 1) {
      library.apply({ ring: { kind: 'pbr', textureSet: 'blued-steel' } });
      await library.ready();
      library.apply({ ring: { kind: 'pbr', textureSet: 'copper-plate' } });
      await library.ready();
    }

    // Three round trips later, exactly as many live textures as at the start.
    expect(registry.stats().textures).toBe(baseline);

    library.dispose();
    registry.dispose();
  });

  it('lands on the last binding asked for, not the last one to finish', async () => {
    const { registry } = harness();
    const library = new MaterialLibrary(slots(), registry);

    library.apply({ ring: { kind: 'pbr', textureSet: 'copper-plate' } });
    library.apply({ ring: { kind: 'pbr', textureSet: 'blued-steel' } });
    library.apply({ ring: { kind: 'pbr', textureSet: 'dark-enamel' } });
    await library.ready();

    expect(library.get('ring').map).toBeNull();
    expect(library.get('ring').color.getHex()).toBe(0x241a12);
    // Nothing acquired by the superseded loads is still held.
    expect(registry.stats().textures).toBe(0);

    library.dispose();
    registry.dispose();
  });

  it('keeps the old surface on screen until the new one is ready', async () => {
    const { registry } = harness();
    const library = new MaterialLibrary(
      slots({ ring: { kind: 'pbr', textureSet: 'copper-plate' } }),
      registry,
    );
    await library.ready();

    const material = library.get('ring');
    library.apply({ ring: { kind: 'pbr', textureSet: 'blued-steel' } });

    // Mid-swap: still fully textured, so there is no untextured frame to see.
    expect(material.map).not.toBeNull();
    expect(material.map?.name).toContain('copper-plate');

    await library.ready();
    expect(material.map?.name).toContain('blued-steel');

    library.dispose();
    registry.dispose();
  });
});

describe('the shipped scene', () => {
  it('binds every slot of copper-padlock to a material folder', () => {
    for (const slot of MATERIAL_SLOTS) {
      expect(copperPadlockScene.materials[slot].kind).toBe('pbr');
    }
  });

  it('references only folders that exist', async () => {
    const { registry } = harness();
    const ids = new Set(
      MATERIAL_SLOTS.map((slot) => {
        const binding = copperPadlockScene.materials[slot];
        return binding.kind === 'pbr' ? binding.textureSet : '';
      }).filter(Boolean),
    );

    for (const id of ids) {
      await expect(registry.manifest(id)).resolves.toMatchObject({ id });
    }
    registry.dispose();
  });
});
