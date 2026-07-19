/**
 * Loading and PMREM caching for lighting-mood environment maps.
 *
 * Two rules this class exists to enforce:
 *
 * 1. **PMREM once per map.** Prefiltering a panorama is the expensive part of
 *    switching moods; the result is cached by preset id and reused for the rest
 *    of the session, so going back to a mood is a synchronous swap.
 * 2. **Nothing is orphaned.** The decoded panorama is disposed the moment PMREM
 *    has consumed it, a result that arrives after `dispose()` is thrown away
 *    rather than cached, and every render target the cache holds is released in
 *    `dispose()`. Scene and mood switching are both supported runtime actions,
 *    so a leak here compounds for as long as the tab is open.
 *
 * The loader and the prefilter are injected so the cache logic is testable in a
 * plain Node environment: `renderer.info` cannot be consulted without a WebGL
 * context, but `liveTargets` is the same conservation property in a form a unit
 * test can assert.
 */

import * as THREE from 'three';
import { BASIS_TRANSCODER_PATH, resolveAssetUrl } from '../../materials/paths.js';
import { iblPresets } from './presets.js';
import type { KTX2Loader } from 'three/examples/jsm/loaders/KTX2Loader.js';
import type { IblEnvironmentFormat, IblManifest } from './manifest.js';
import type { IblPresetSource } from './presets.js';

/** Decodes a panorama URL into a texture ready for prefiltering. */
export interface PanoramaLoader {
  load(url: string, format: IblEnvironmentFormat): Promise<THREE.Texture>;
  /** Releases anything the loader holds beyond the textures it handed out. */
  dispose?(): void;
}

/**
 * Prefilters an equirectangular texture into a mip-chained environment map.
 *
 * The render target is the caller's to dispose; that is the whole reason this
 * returns the target rather than just its texture.
 */
export interface EnvironmentPrefilter {
  compile(source: THREE.Texture): THREE.WebGLRenderTarget;
  dispose(): void;
}

export interface EnvironmentLibraryOptions {
  readonly presets: IblPresetSource;
  readonly loader: PanoramaLoader;
  readonly prefilter: EnvironmentPrefilter;
}

export interface LoadedEnvironment {
  readonly manifest: IblManifest;
  readonly texture: THREE.Texture;
}

/**
 * What `EnvironmentController` needs from a cache of environment maps.
 *
 * Naming the seam rather than the class is what lets the controller's
 * atomicity and leak behaviour be tested without a WebGL context.
 */
export interface EnvironmentSource {
  /** Prefiltered maps currently resident on the GPU. */
  readonly liveTargets: number;
  /** The mood if it can be applied synchronously, otherwise null. */
  peek(id: string): LoadedEnvironment | null;
  load(id: string): Promise<LoadedEnvironment>;
  dispose(): void;
}

export class EnvironmentLibrary implements EnvironmentSource {
  private readonly presets: IblPresetSource;
  private readonly loader: PanoramaLoader;
  private readonly prefilter: EnvironmentPrefilter;

  private readonly cache = new Map<
    string,
    { manifest: IblManifest; target: THREE.WebGLRenderTarget }
  >();
  private readonly inFlight = new Map<string, Promise<LoadedEnvironment>>();
  private disposed = false;

  constructor({ presets, loader, prefilter }: EnvironmentLibraryOptions) {
    this.presets = presets;
    this.loader = loader;
    this.prefilter = prefilter;
  }

  /** Prefiltered environment maps currently held on the GPU. */
  get liveTargets(): number {
    return this.cache.size;
  }

  /**
   * The mood if it is already prefiltered, otherwise null.
   *
   * A non-null answer means the caller can apply the mood in this very frame,
   * with no window in which the environment and the light rig disagree.
   */
  peek(id: string): LoadedEnvironment | null {
    const hit = this.cache.get(id);
    return hit ? { manifest: hit.manifest, texture: hit.target.texture } : null;
  }

  /** Loads, prefilters and caches a mood. Concurrent calls share one load. */
  load(id: string): Promise<LoadedEnvironment> {
    if (this.disposed) return Promise.reject(new Error('EnvironmentLibrary is disposed'));

    const cached = this.peek(id);
    if (cached) return Promise.resolve(cached);

    const existing = this.inFlight.get(id);
    if (existing) return existing;

    const started = this.build(id).finally(() => {
      this.inFlight.delete(id);
    });
    this.inFlight.set(id, started);
    return started;
  }

  private async build(id: string): Promise<LoadedEnvironment> {
    const entry = this.presets.get(id);
    if (!entry) throw new Error(`No IBL preset folder named "${id}" under assets/ibl/`);

    const manifest = await entry.loadManifest();
    const url = await entry.loadPanoramaUrl(manifest.environment.file);
    const source = await this.loader.load(url, manifest.environment.format);

    // A second caller may have finished while this one was on the network.
    // Prefiltering again would double the GPU cost for an identical result.
    const raced = this.cache.get(id);
    if (raced) {
      source.dispose();
      return { manifest: raced.manifest, texture: raced.target.texture };
    }

    let target: THREE.WebGLRenderTarget;
    try {
      target = this.prefilter.compile(source);
    } finally {
      // PMREM copies the panorama into its own mip chain, so the decoded
      // source is dead weight from here on — including if compile threw.
      source.dispose();
    }

    if (this.disposed) {
      // The renderer went away mid-load. Caching this would leak a render
      // target that nothing will ever dispose.
      target.dispose();
      throw new Error('EnvironmentLibrary was disposed while loading');
    }

    this.cache.set(id, { manifest, target });
    return { manifest, texture: target.texture };
  }

  dispose(): void {
    this.disposed = true;
    for (const { target } of this.cache.values()) target.dispose();
    this.cache.clear();
    this.inFlight.clear();
    this.prefilter.dispose();
    this.loader.dispose?.();
  }
}

/** The library the app runs on: real decoders, real PMREM, real GPU memory. */
export function createEnvironmentLibrary(renderer: THREE.WebGLRenderer): EnvironmentLibrary {
  return new EnvironmentLibrary({
    presets: iblPresets,
    loader: new ThreePanoramaLoader(renderer),
    prefilter: new PmremPrefilter(renderer),
  });
}

/** Prefilter backed by three.js's `PMREMGenerator`. */
export class PmremPrefilter implements EnvironmentPrefilter {
  private readonly generator: THREE.PMREMGenerator;

  constructor(renderer: THREE.WebGLRenderer) {
    // Constructing the generator is cheap — it only holds the renderer. The
    // equirectangular shader is deliberately *not* compiled here: that is real
    // GPU work, and it would land on the critical path to first paint for the
    // sake of a hitch on a switch the viewer may never make.
    this.generator = new THREE.PMREMGenerator(renderer);
  }

  compile(source: THREE.Texture): THREE.WebGLRenderTarget {
    return this.generator.fromEquirectangular(source);
  }

  dispose(): void {
    this.generator.dispose();
  }
}

/**
 * Panorama decoding.
 *
 * Loaders are imported dynamically so that the decoder for a format nobody
 * selected never reaches the browser: choosing `day` should not ship an EXR
 * decoder.
 */
export class ThreePanoramaLoader implements PanoramaLoader {
  private readonly renderer: THREE.WebGLRenderer;
  private ktx2Loader: KTX2Loader | null = null;
  private ktx2: Promise<KTX2Loader> | null = null;
  private disposed = false;

  /** The renderer is what `KTX2Loader.detectSupport` reads GPU formats off. */
  constructor(renderer: THREE.WebGLRenderer) {
    this.renderer = renderer;
  }

  async load(url: string, format: IblEnvironmentFormat): Promise<THREE.Texture> {
    switch (format) {
      case 'rgbe': {
        const { HDRLoader } = await import('three/examples/jsm/loaders/HDRLoader.js');
        return this.decode(new HDRLoader(), url);
      }
      case 'exr': {
        const { EXRLoader } = await import('three/examples/jsm/loaders/EXRLoader.js');
        return this.decode(new EXRLoader(), url);
      }
      case 'ktx2':
        return this.decode(await this.transcoder(), url);
    }
  }

  /**
   * The KTX2/Basis transcoder, created on the first `.ktx2` panorama.
   *
   * The wasm binaries are synced into `public/basis/` from `three` at build
   * time (`scripts/sync-basis-transcoder.mjs`, shared with the material
   * pipeline) and fetched at runtime, so the URL must be joined onto
   * `import.meta.env.BASE_URL` by hand — a root-absolute path 404s on the
   * GitHub Pages project page, and `scripts/check-base-path.mjs` fails the
   * build on exactly that.
   *
   * Unlike the material registry there is no uncompressed fallback to prefer:
   * the preset names exactly one panorama, so a transcoder that cannot load
   * rejects — and that rejection surfaces through the environment controller,
   * which keeps the previous mood whole. Failing loudly beats silently
   * rendering the wrong mood.
   */
  private transcoder(): Promise<KTX2Loader> {
    if (this.ktx2) return this.ktx2;

    const attempt = import('three/examples/jsm/loaders/KTX2Loader.js').then(({ KTX2Loader }) => {
      const loader = new KTX2Loader()
        .setTranscoderPath(resolveAssetUrl(BASIS_TRANSCODER_PATH))
        .detectSupport(this.renderer);
      if (this.disposed) {
        // The renderer went away while the module was on the network. Caching
        // the loader now would leak its worker pool for the rest of the tab.
        loader.dispose();
        throw new Error('ThreePanoramaLoader was disposed while loading the KTX2 transcoder');
      }
      this.ktx2Loader = loader;
      return loader;
    });

    this.ktx2 = attempt;
    void attempt.catch(() => {
      // Only successes stay memoised — the same rule the library applies to
      // panorama loads. A transient chunk-fetch failure that stuck around
      // would poison every later ktx2 mood for the session, and the mood
      // picker is a natural retry surface. (After dispose() the memo is
      // already null, so this leaves the disposed rejection alone.)
      if (this.ktx2 === attempt) this.ktx2 = null;
    });
    return attempt;
  }

  dispose(): void {
    this.disposed = true;
    // The KTX2 loader owns a worker pool; terminating it is what this method
    // exists for. Decoded textures are the library's to dispose, not ours.
    this.ktx2Loader?.dispose();
    this.ktx2Loader = null;
    this.ktx2 = null;
  }

  private decode(
    loader: {
      load: (
        url: string,
        onLoad: (t: THREE.Texture) => void,
        onProgress: undefined,
        onError: (e: unknown) => void,
      ) => void;
    },
    url: string,
  ): Promise<THREE.Texture> {
    return new Promise((resolve, reject) => {
      loader.load(
        url,
        (texture) => {
          texture.mapping = THREE.EquirectangularReflectionMapping;
          resolve(texture);
        },
        undefined,
        (error: unknown) => {
          reject(error instanceof Error ? error : new Error(`Failed to load ${url}`));
        },
      );
    });
  }
}
