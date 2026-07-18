import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { EnvironmentLibrary } from './library.js';
import { parseIblManifest } from './manifest.js';
import type { EnvironmentPrefilter, PanoramaLoader } from './library.js';
import type { IblPresetEntry, IblPresetSource } from './presets.js';

/**
 * `renderer.info` needs a WebGL context, which these tests deliberately do not
 * have. `liveTargets` and the fakes below track exactly the same thing — how
 * many GPU objects exist and whether each was released — in a form a plain Node
 * test can assert. The property under test is conservation: switching moods any
 * number of times must never leave a prefiltered target or a decoded panorama
 * that nothing will free.
 */
class FakePrefilter implements EnvironmentPrefilter {
  compiled = 0;
  disposedGenerator = false;
  readonly live = new Set<THREE.WebGLRenderTarget>();

  compile(_source: THREE.Texture): THREE.WebGLRenderTarget {
    this.compiled += 1;
    const target = {
      texture: new THREE.Texture(),
      dispose: () => {
        this.live.delete(target);
      },
    } as unknown as THREE.WebGLRenderTarget;
    this.live.add(target);
    return target;
  }

  dispose(): void {
    this.disposedGenerator = true;
  }
}

interface FakeLoader extends PanoramaLoader {
  loads: number;
  readonly sources: THREE.Texture[];
  readonly disposedSources: Set<THREE.Texture>;
}

function fakeLoader(): FakeLoader {
  const sources: THREE.Texture[] = [];
  const disposedSources = new Set<THREE.Texture>();

  return {
    loads: 0,
    sources,
    disposedSources,
    load(_url: string): Promise<THREE.Texture> {
      this.loads += 1;
      const texture = new THREE.Texture();
      texture.addEventListener('dispose', () => disposedSources.add(texture));
      sources.push(texture);
      return Promise.resolve(texture);
    },
  };
}

function fakePresets(ids: readonly string[]): IblPresetSource {
  const entries = new Map<string, IblPresetEntry>(
    ids.map((id) => [
      id,
      {
        id,
        loadManifest: () =>
          Promise.resolve(
            parseIblManifest(
              {
                id,
                name: id,
                environment: { file: `${id}.hdr`, format: 'rgbe' },
                background: { mode: 'environment', fallback: { kind: 'color', color: '#000000' } },
                grade: { exposure: 1, toneMapping: 'aces' },
                lights: [{ type: 'ambient', color: '#ffffff' }],
                source: {
                  title: id,
                  authors: ['A'],
                  provider: 'P',
                  url: 'https://example.invalid',
                  licence: 'CC0-1.0',
                },
              },
              id,
            ),
          ),
        loadPanoramaUrl: (file: string) => Promise.resolve(`/fake/${id}/${file}`),
      },
    ]),
  );

  return { get: (id) => entries.get(id) ?? null, list: () => [...entries.keys()] };
}

function build(ids: readonly string[] = ['day', 'night']): {
  library: EnvironmentLibrary;
  loader: FakeLoader;
  prefilter: FakePrefilter;
} {
  const loader = fakeLoader();
  const prefilter = new FakePrefilter();
  const library = new EnvironmentLibrary({ presets: fakePresets(ids), loader, prefilter });
  return { library, loader, prefilter };
}

describe('EnvironmentLibrary', () => {
  it('prefilters a map once and serves it synchronously ever after', async () => {
    const { library, prefilter } = build();

    const first = await library.load('day');
    expect(prefilter.compiled).toBe(1);

    // The second visit touches neither the network nor the GPU. That is what
    // lets a mood switch commit inside one frame, with no intermediate state.
    expect(library.peek('day')?.texture).toBe(first.texture);
    expect((await library.load('day')).texture).toBe(first.texture);
    expect(prefilter.compiled).toBe(1);

    library.dispose();
  });

  it('has nothing to peek before a mood has been loaded', () => {
    const { library } = build();
    expect(library.peek('day')).toBeNull();
    library.dispose();
  });

  it('disposes the decoded panorama once PMREM has consumed it', async () => {
    const { library, loader } = build();

    await library.load('day');

    // The float panorama is several times the size of the prefiltered chain,
    // and PMREM has already copied everything it needs out of it.
    expect(loader.sources).toHaveLength(1);
    expect(loader.disposedSources.has(loader.sources[0]!)).toBe(true);
    library.dispose();
  });

  it('disposes the decoded panorama even when prefiltering throws', async () => {
    const loader = fakeLoader();
    const prefilter = new FakePrefilter();
    prefilter.compile = (): THREE.WebGLRenderTarget => {
      throw new Error('GPU said no');
    };
    const library = new EnvironmentLibrary({ presets: fakePresets(['day']), loader, prefilter });

    await expect(library.load('day')).rejects.toThrow('GPU said no');

    expect(loader.disposedSources.has(loader.sources[0]!)).toBe(true);
    expect(library.liveTargets).toBe(0);
    library.dispose();
  });

  it('shares one load between concurrent callers', async () => {
    const { library, loader, prefilter } = build();

    const [a, b, c] = await Promise.all([
      library.load('night'),
      library.load('night'),
      library.load('night'),
    ]);

    expect(loader.loads).toBe(1);
    expect(prefilter.compiled).toBe(1);
    expect(a.texture).toBe(b.texture);
    expect(b.texture).toBe(c.texture);
    library.dispose();
  });

  it('retries after a failure rather than caching the rejection', async () => {
    const loader = fakeLoader();
    const prefilter = new FakePrefilter();
    let attempt = 0;
    const original = loader.load.bind(loader);
    loader.load = (url: string): Promise<THREE.Texture> => {
      attempt += 1;
      return attempt === 1 ? Promise.reject(new Error('offline')) : original(url, 'rgbe');
    };
    const library = new EnvironmentLibrary({ presets: fakePresets(['day']), loader, prefilter });

    await expect(library.load('day')).rejects.toThrow('offline');
    await expect(library.load('day')).resolves.toBeDefined();
    expect(library.liveTargets).toBe(1);

    library.dispose();
  });

  it('holds one target per distinct mood, however often moods are switched', async () => {
    const { library, prefilter } = build(['day', 'night']);

    for (let i = 0; i < 6; i += 1) {
      await library.load(i % 2 === 0 ? 'day' : 'night');
    }

    // Six switches, two maps. The cache is what stops repeated switching from
    // growing GPU memory without bound.
    expect(prefilter.compiled).toBe(2);
    expect(library.liveTargets).toBe(2);
    expect(prefilter.live.size).toBe(2);

    library.dispose();
    expect(library.liveTargets).toBe(0);
    expect(prefilter.live.size).toBe(0);
    expect(prefilter.disposedGenerator).toBe(true);
  });

  it('throws away a result that lands after disposal instead of caching it', async () => {
    const loader = fakeLoader();
    const prefilter = new FakePrefilter();
    const library = new EnvironmentLibrary({ presets: fakePresets(['day']), loader, prefilter });

    const pending = library.load('day');
    library.dispose();

    await expect(pending).rejects.toThrow(/disposed/);
    // The target was created before disposal noticed. Dropping the promise on
    // the floor would have leaked it, because nothing else holds a reference.
    expect(prefilter.live.size).toBe(0);
    expect(library.liveTargets).toBe(0);
  });

  it('rejects for a mood with no folder under assets/ibl', async () => {
    const { library } = build(['day']);
    await expect(library.load('atlantis')).rejects.toThrow(/No IBL preset folder/);
    library.dispose();
  });
});
