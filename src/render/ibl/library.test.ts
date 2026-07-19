import * as THREE from 'three';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BASIS_TRANSCODER_PATH, resolveAssetUrl } from '../../materials/paths.js';
import { EnvironmentDisposedError, EnvironmentLibrary, ThreePanoramaLoader } from './library.js';
import { parseIblManifest } from './manifest.js';
import type { EnvironmentPrefilter, PanoramaLoader } from './library.js';
import type { IblEnvironmentFormat } from './manifest.js';
import type { IblPresetEntry, IblPresetSource } from './presets.js';

/**
 * `KTX2Loader` cannot run under Node — its transcoder is wasm in a Worker —
 * so the module is mocked and the assertions are about the *wiring*: which
 * transcoder path the loader is given, which renderer detects support, and
 * that its worker pool is torn down. The real transcode is exercised in a
 * browser, not here.
 */
const ktx2 = vi.hoisted(() => {
  class FakeKTX2Loader {
    static instances: FakeKTX2Loader[] = [];
    /** Makes the next construction throw, as a failed chunk fetch would. */
    static failNextConstruction = false;

    transcoderPath: string | null = null;
    detectedWith: unknown = null;
    disposed = false;
    disposeCalls = 0;
    readonly requests: {
      url: string;
      onLoad: (t: unknown) => void;
      onError: (e: unknown) => void;
    }[] = [];

    constructor() {
      if (FakeKTX2Loader.failNextConstruction) {
        FakeKTX2Loader.failNextConstruction = false;
        throw new Error('chunk failed to fetch');
      }
      FakeKTX2Loader.instances.push(this);
    }

    setTranscoderPath(path: string): this {
      this.transcoderPath = path;
      return this;
    }

    detectSupport(renderer: unknown): this {
      this.detectedWith = renderer;
      return this;
    }

    load(
      url: string,
      onLoad: (t: unknown) => void,
      _onProgress: unknown,
      onError: (e: unknown) => void,
    ): void {
      this.requests.push({ url, onLoad, onError });
    }

    dispose(): void {
      this.disposed = true;
      this.disposeCalls += 1;
    }
  }

  return { FakeKTX2Loader };
});

vi.mock('three/examples/jsm/loaders/KTX2Loader.js', () => ({
  KTX2Loader: ktx2.FakeKTX2Loader,
}));

/**
 * `HDRLoader` would hit the network under Node; like the KTX2 mock above it is
 * replaced with a hand that holds the callbacks, so a test can dispose the
 * panorama loader while a decode is mid-flight and then deliver (or fail) the
 * request afterwards — the exact teardown race the registry exists for.
 */
const hdr = vi.hoisted(() => {
  class FakeHDRLoader {
    static instances: FakeHDRLoader[] = [];

    readonly requests: {
      url: string;
      onLoad: (t: unknown) => void;
      onError: (e: unknown) => void;
    }[] = [];

    constructor() {
      FakeHDRLoader.instances.push(this);
    }

    load(
      url: string,
      onLoad: (t: unknown) => void,
      _onProgress: unknown,
      onError: (e: unknown) => void,
    ): void {
      this.requests.push({ url, onLoad, onError });
    }
  }

  return { FakeHDRLoader };
});

vi.mock('three/examples/jsm/loaders/HDRLoader.js', () => ({
  HDRLoader: hdr.FakeHDRLoader,
}));

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
  disposeCalls = 0;
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
    this.disposeCalls += 1;
  }
}

interface FakeLoader extends PanoramaLoader {
  loads: number;
  disposedCalls: number;
  readonly formats: IblEnvironmentFormat[];
  readonly sources: THREE.Texture[];
  readonly disposedSources: Set<THREE.Texture>;
}

function fakeLoader(): FakeLoader {
  const sources: THREE.Texture[] = [];
  const disposedSources = new Set<THREE.Texture>();

  return {
    loads: 0,
    disposedCalls: 0,
    formats: [],
    sources,
    disposedSources,
    load(_url: string, format: IblEnvironmentFormat): Promise<THREE.Texture> {
      this.loads += 1;
      this.formats.push(format);
      const texture = new THREE.Texture();
      texture.addEventListener('dispose', () => disposedSources.add(texture));
      sources.push(texture);
      return Promise.resolve(texture);
    },
    dispose(): void {
      this.disposedCalls += 1;
    },
  };
}

function fakePresets(
  ids: readonly string[],
  format: IblEnvironmentFormat = 'rgbe',
): IblPresetSource {
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
                environment: { file: `${id}.${format === 'rgbe' ? 'hdr' : format}`, format },
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

    await expect(pending).rejects.toBeInstanceOf(EnvironmentDisposedError);
    // Disposal is noticed before the prefilter — already torn down by now —
    // is asked for anything, and the decoded panorama dies with the load
    // instead of being orphaned.
    expect(prefilter.compiled).toBe(0);
    expect(loader.disposedSources.has(loader.sources[0]!)).toBe(true);
    expect(prefilter.live.size).toBe(0);
    expect(library.liveTargets).toBe(0);
  });

  it('settles an in-flight load through the loader contract when disposed mid-decode', async () => {
    // A KTX2 worker pool never calls back once terminated, so left alone the
    // decode promise would pend forever. `PanoramaLoader.dispose` is required
    // to reject what it still owes; this pins that the library's own promise
    // comes to rest through that rejection.
    const prefilter = new FakePrefilter();
    const pendingRejects = new Set<(error: Error) => void>();
    const loader: PanoramaLoader = {
      load: () =>
        new Promise<THREE.Texture>((_resolve, reject) => {
          pendingRejects.add(reject);
        }),
      dispose: () => {
        for (const reject of pendingRejects) {
          reject(new EnvironmentDisposedError('loader disposed while decoding'));
        }
        pendingRejects.clear();
      },
    };
    const library = new EnvironmentLibrary({ presets: fakePresets(['day']), loader, prefilter });

    const pending = library.load('day');
    // Wait until the decode is genuinely in flight — past the manifest and
    // URL imports — so disposal races the decoder, not the preset source.
    await vi.waitFor(() => expect(pendingRejects.size).toBe(1));
    library.dispose();

    await expect(pending).rejects.toBeInstanceOf(EnvironmentDisposedError);
    expect(prefilter.compiled).toBe(0);
    expect(library.liveTargets).toBe(0);
  });

  it('rejects a load requested after disposal', async () => {
    const { library } = build();
    library.dispose();
    await expect(library.load('day')).rejects.toBeInstanceOf(EnvironmentDisposedError);
  });

  it('tears everything down exactly once however often dispose is called', async () => {
    const { library, loader, prefilter } = build();
    await library.load('day');

    library.dispose();
    library.dispose();

    // A second dispose must not re-release GPU objects the first one already
    // gave back — double-freeing a shared generator or worker pool is how a
    // teardown ordering bug in one owner corrupts the other.
    expect(loader.disposedCalls).toBe(1);
    expect(prefilter.disposeCalls).toBe(1);
    expect(library.liveTargets).toBe(0);
    expect(prefilter.live.size).toBe(0);
  });

  it('rejects for a mood with no folder under assets/ibl', async () => {
    const { library } = build(['day']);
    await expect(library.load('atlantis')).rejects.toThrow(/No IBL preset folder/);
    library.dispose();
  });

  it('disposes the panorama loader with the library', () => {
    const { library, loader } = build();
    library.dispose();
    // The loader may hold a KTX2 transcoder worker pool; the library owns the
    // loader, so tearing the library down must tear that down too.
    expect(loader.disposedCalls).toBe(1);
  });

  it('hands the manifest format to the panorama loader', async () => {
    const loader = fakeLoader();
    const prefilter = new FakePrefilter();
    const library = new EnvironmentLibrary({
      presets: fakePresets(['day'], 'ktx2'),
      loader,
      prefilter,
    });

    await library.load('day');

    // The format is what routes a panorama to the right decoder; a preset
    // declaring ktx2 must not silently fall through to the rgbe path.
    expect(loader.formats).toEqual(['ktx2']);
    library.dispose();
  });
});

describe('ThreePanoramaLoader (ktx2)', () => {
  afterEach(() => {
    ktx2.FakeKTX2Loader.instances.length = 0;
    ktx2.FakeKTX2Loader.failNextConstruction = false;
    vi.unstubAllEnvs();
  });

  const fakeRenderer = (): THREE.WebGLRenderer => ({}) as unknown as THREE.WebGLRenderer;

  it('routes a .ktx2 panorama through a transcoder served under the app base', async () => {
    const renderer = fakeRenderer();
    const loader = new ThreePanoramaLoader(renderer);

    const pending = loader.load('/fake/night/pano.ktx2', 'ktx2');

    await vi.waitFor(() => expect(ktx2.FakeKTX2Loader.instances).toHaveLength(1));
    const instance = ktx2.FakeKTX2Loader.instances[0]!;

    // The transcoder is fetched at runtime, so its URL must be joined onto
    // BASE_URL — a root-absolute path 404s on a GitHub Pages project page.
    expect(instance.transcoderPath).toBe(resolveAssetUrl(BASIS_TRANSCODER_PATH));
    expect(instance.transcoderPath?.endsWith('basis/')).toBe(true);
    // Support detection must read formats off the real context, not a guess.
    expect(instance.detectedWith).toBe(renderer);

    await vi.waitFor(() => expect(instance.requests).toHaveLength(1));
    expect(instance.requests[0]!.url).toBe('/fake/night/pano.ktx2');

    const texture = new THREE.Texture();
    instance.requests[0]!.onLoad(texture);
    await expect(pending).resolves.toBe(texture);
    // PMREM's fromEquirectangular reads the mapping; without it the panorama
    // would be prefiltered as if it were a flat texture.
    expect(texture.mapping).toBe(THREE.EquirectangularReflectionMapping);

    loader.dispose();
    expect(instance.disposed).toBe(true);
  });

  it('creates one transcoder however many panoramas load', async () => {
    const loader = new ThreePanoramaLoader(fakeRenderer());

    const first = loader.load('/fake/a.ktx2', 'ktx2');
    const second = loader.load('/fake/b.ktx2', 'ktx2');

    await vi.waitFor(() => {
      const requests = ktx2.FakeKTX2Loader.instances.flatMap((i) => i.requests);
      expect(requests).toHaveLength(2);
    });
    // One worker pool per renderer, not one per mood.
    expect(ktx2.FakeKTX2Loader.instances).toHaveLength(1);

    const instance = ktx2.FakeKTX2Loader.instances[0]!;
    for (const request of instance.requests) request.onLoad(new THREE.Texture());
    await expect(first).resolves.toBeInstanceOf(THREE.Texture);
    await expect(second).resolves.toBeInstanceOf(THREE.Texture);

    loader.dispose();
  });

  it('surfaces a failed load as a rejection naming the file', async () => {
    const loader = new ThreePanoramaLoader(fakeRenderer());

    const pending = loader.load('/fake/broken.ktx2', 'ktx2');
    await vi.waitFor(() => expect(ktx2.FakeKTX2Loader.instances[0]?.requests).toHaveLength(1));

    ktx2.FakeKTX2Loader.instances[0]!.requests[0]!.onError('not an Error instance');
    await expect(pending).rejects.toThrow('Failed to load /fake/broken.ktx2');

    loader.dispose();
  });

  it('passes a transcoder Error through unwrapped', async () => {
    const loader = new ThreePanoramaLoader(fakeRenderer());

    const pending = loader.load('/fake/broken.ktx2', 'ktx2');
    await vi.waitFor(() => expect(ktx2.FakeKTX2Loader.instances[0]?.requests).toHaveLength(1));

    // The transcoder's own message is the diagnosable one; wrapping it would
    // bury which of the fetch, the wasm or the transcode actually failed.
    const failure = new Error('transcoder said no');
    ktx2.FakeKTX2Loader.instances[0]!.requests[0]!.onError(failure);
    await expect(pending).rejects.toBe(failure);

    loader.dispose();
  });

  it('joins the transcoder path onto a sub-path base URL', async () => {
    // The GitHub Pages deployment serves from /babbage-clock/, not the site
    // root; under Vitest BASE_URL defaults to '/', which would let a
    // hardcoded root-absolute path pass unnoticed.
    vi.stubEnv('BASE_URL', '/babbage-clock/');
    const loader = new ThreePanoramaLoader(fakeRenderer());

    const pending = loader.load('/fake/a.ktx2', 'ktx2');
    await vi.waitFor(() => expect(ktx2.FakeKTX2Loader.instances).toHaveLength(1));
    const instance = ktx2.FakeKTX2Loader.instances[0]!;
    expect(instance.transcoderPath).toBe('/babbage-clock/basis/');

    await vi.waitFor(() => expect(instance.requests).toHaveLength(1));
    instance.requests[0]!.onLoad(new THREE.Texture());
    await pending;
    loader.dispose();
  });

  it('retries the transcoder import after a transient failure', async () => {
    ktx2.FakeKTX2Loader.failNextConstruction = true;
    const loader = new ThreePanoramaLoader(fakeRenderer());

    await expect(loader.load('/fake/a.ktx2', 'ktx2')).rejects.toThrow('chunk failed to fetch');

    // Only successes stay memoised: re-picking the mood must try again, not
    // replay a cached rejection for the rest of the session.
    const retry = loader.load('/fake/a.ktx2', 'ktx2');
    await vi.waitFor(() => expect(ktx2.FakeKTX2Loader.instances).toHaveLength(1));
    const instance = ktx2.FakeKTX2Loader.instances[0]!;
    await vi.waitFor(() => expect(instance.requests).toHaveLength(1));

    instance.requests[0]!.onLoad(new THREE.Texture());
    await expect(retry).resolves.toBeInstanceOf(THREE.Texture);
    loader.dispose();
  });

  it('tears down a transcoder that finishes loading after disposal', async () => {
    const loader = new ThreePanoramaLoader(fakeRenderer());

    const pending = loader.load('/fake/late.ktx2', 'ktx2');
    // Dispose before the dynamic import's microtask lands: the transcoder is
    // still on its way. Keeping it would leak its worker pool for the rest of
    // the tab, because nothing would ever dispose it again.
    loader.dispose();

    await expect(pending).rejects.toBeInstanceOf(EnvironmentDisposedError);
    expect(ktx2.FakeKTX2Loader.instances).toHaveLength(1);
    expect(ktx2.FakeKTX2Loader.instances[0]!.disposed).toBe(true);
  });

  it('rejects a decode in flight at disposal and frees a texture that arrives late', async () => {
    const loader = new ThreePanoramaLoader(fakeRenderer());

    const pending = loader.load('/fake/inflight.ktx2', 'ktx2');
    await vi.waitFor(() => expect(ktx2.FakeKTX2Loader.instances[0]?.requests).toHaveLength(1));
    const instance = ktx2.FakeKTX2Loader.instances[0]!;

    loader.dispose();

    // Terminating the worker pool silently dropped the job — neither callback
    // will ever fire from the pool's side. The pending registry is the only
    // thing standing between this promise and pending forever.
    await expect(pending).rejects.toBeInstanceOf(EnvironmentDisposedError);
    await expect(pending).rejects.toThrow('/fake/inflight.ktx2');
    expect(instance.disposed).toBe(true);

    // A result can still slip out between the worker's last post and the
    // pool's termination. The promise already rejected, so nobody else can
    // ever receive this texture; the loader must free it, not orphan it.
    const late = new THREE.Texture();
    let freed = false;
    late.addEventListener('dispose', () => {
      freed = true;
    });
    instance.requests[0]!.onLoad(late);
    expect(freed).toBe(true);
  });

  it('tears the worker pool down exactly once however often dispose is called', async () => {
    const loader = new ThreePanoramaLoader(fakeRenderer());

    const pending = loader.load('/fake/a.ktx2', 'ktx2');
    await vi.waitFor(() => expect(ktx2.FakeKTX2Loader.instances[0]?.requests).toHaveLength(1));

    loader.dispose();
    loader.dispose();

    expect(ktx2.FakeKTX2Loader.instances[0]!.disposeCalls).toBe(1);
    await expect(pending).rejects.toBeInstanceOf(EnvironmentDisposedError);
  });
});

describe('ThreePanoramaLoader (rgbe)', () => {
  afterEach(() => {
    hdr.FakeHDRLoader.instances.length = 0;
  });

  const fakeRenderer = (): THREE.WebGLRenderer => ({}) as unknown as THREE.WebGLRenderer;

  it('rejects a decode in flight at disposal and frees a texture that arrives late', async () => {
    const loader = new ThreePanoramaLoader(fakeRenderer());

    const pending = loader.load('/fake/mood.hdr', 'rgbe');
    await vi.waitFor(() => expect(hdr.FakeHDRLoader.instances[0]?.requests).toHaveLength(1));
    const instance = hdr.FakeHDRLoader.instances[0]!;
    expect(instance.requests[0]!.url).toBe('/fake/mood.hdr');

    loader.dispose();

    await expect(pending).rejects.toBeInstanceOf(EnvironmentDisposedError);
    await expect(pending).rejects.toThrow('/fake/mood.hdr');

    // Unlike KTX2's worker pool the HDR fetch cannot be cancelled, so the
    // decoded texture may well still arrive. Its promise already rejected;
    // the loader is the only owner left to free it.
    const late = new THREE.Texture();
    let freed = false;
    late.addEventListener('dispose', () => {
      freed = true;
    });
    instance.requests[0]!.onLoad(late);
    expect(freed).toBe(true);
  });

  it('ignores a failure that lands after disposal already rejected the decode', async () => {
    const loader = new ThreePanoramaLoader(fakeRenderer());

    const pending = loader.load('/fake/mood.hdr', 'rgbe');
    await vi.waitFor(() => expect(hdr.FakeHDRLoader.instances[0]?.requests).toHaveLength(1));

    loader.dispose();
    await expect(pending).rejects.toBeInstanceOf(EnvironmentDisposedError);

    // The aborted fetch surfacing its own error afterwards must not turn into
    // an unhandled rejection or clobber the disposal error.
    hdr.FakeHDRLoader.instances[0]!.requests[0]!.onError(new Error('network gave up'));
    await expect(pending).rejects.toBeInstanceOf(EnvironmentDisposedError);
  });

  it('rejects a load requested after disposal without creating a decoder', async () => {
    const loader = new ThreePanoramaLoader(fakeRenderer());
    loader.dispose();

    await expect(loader.load('/fake/late.hdr', 'rgbe')).rejects.toBeInstanceOf(
      EnvironmentDisposedError,
    );
    await expect(loader.load('/fake/late.ktx2', 'ktx2')).rejects.toBeInstanceOf(
      EnvironmentDisposedError,
    );

    // Refusing up front is the point: no decoder chunk is fetched and no
    // transcoder worker pool is built for a renderer that no longer exists.
    expect(hdr.FakeHDRLoader.instances).toHaveLength(0);
    expect(ktx2.FakeKTX2Loader.instances).toHaveLength(0);
  });
});
