/**
 * Loads material folders and hands out textures.
 *
 * This is the only place a `material.json` becomes GPU state. It owns three
 * things nothing else should have to think about:
 *
 * 1. **Colour space, per map.** Base colour and emissive are decoded as sRGB;
 *    roughness, metalness, occlusion, height and normals are raw linear data.
 *    The manifest cannot override it — see `src/materials/manifest.ts` for why
 *    that decision is taken away from the author.
 * 2. **Caching and reference counting.** A material folder is fetched once, its
 *    images are decoded once, and the GPU upload is shared by every slot using
 *    it (three.js keys the upload on `Texture.source`, so a clone costs an
 *    object and no video memory). When the last user lets go, the texture is
 *    disposed. Scene switching and look switching are supported runtime
 *    actions, so a leak here compounds every time the viewer changes their
 *    mind.
 * 3. **Delivery format.** A manifest may list a KTX2/BasisU file beside its
 *    PNG. The KTX2 path is taken only when a transcoder is actually available
 *    in this browser; otherwise the uncompressed file is used and nothing is
 *    said about it, because there is nothing the viewer could do.
 */

import * as THREE from 'three';
import {
  MANIFEST_FILENAME,
  materialFileUrl,
  materialFolderUrl,
  resolveAssetUrl,
  BASIS_TRANSCODER_PATH,
} from '../materials/paths.js';
import { parseMaterialManifest } from '../materials/manifest.js';
import type { MapSource, MaterialManifest } from '../materials/manifest.js';
import type { KTX2Loader } from 'three/examples/jsm/loaders/KTX2Loader.js';

/** Highest anisotropic filtering we ask for; beyond this the cost outruns the gain. */
const MAX_ANISOTROPY = 8;

/** How a texture is laid over a surface. Part of a texture's cache identity. */
export interface TextureTransform {
  readonly repeat: readonly [number, number];
  readonly offset: readonly [number, number];
  readonly rotation: number;
}

export const IDENTITY_TRANSFORM: TextureTransform = {
  repeat: [1, 1],
  offset: [0, 0],
  rotation: 0,
};

export interface MaterialRegistryOptions {
  /** Overrides the app base; tests point this at a fixture directory. */
  readonly baseUrl?: string;
  /**
   * Used to detect KTX2 transcoder support and the anisotropy cap. Without one
   * the registry still works: it loads PNG/JPG and uses conservative defaults.
   */
  readonly renderer?: THREE.WebGLRenderer;
  /** Injected for tests; defaults to `globalThis.fetch`. */
  readonly fetchImpl?: typeof fetch;
  /** Injected for tests; defaults to a three.js `TextureLoader`. */
  readonly loadTexture?: (url: string) => Promise<THREE.Texture>;
}

export interface MaterialRegistryStats {
  /** Manifests fetched (or in flight). */
  readonly manifests: number;
  /** Distinct image files decoded and held in the cache. */
  readonly sources: number;
  /** Live texture instances handed out and not yet released. */
  readonly textures: number;
  /** Loads still in flight. */
  readonly pending: number;
  /** True when a KTX2 transcoder was found and compressed maps are preferred. */
  readonly ktx2: boolean;
}

interface TextureEntry {
  refs: number;
  /** Resolves to the configured clone. Shared by every concurrent acquirer. */
  promise: Promise<THREE.Texture>;
  /** Set once the promise settles; null while the image is still decoding. */
  texture: THREE.Texture | null;
}

/** A texture handed out by the registry, with the key needed to give it back. */
export interface AcquiredTexture {
  readonly key: string;
  readonly texture: THREE.Texture;
}

export class MaterialRegistry {
  private readonly baseUrl: string | undefined;
  private readonly renderer: THREE.WebGLRenderer | undefined;
  private readonly fetchImpl: typeof fetch;
  private readonly loadTextureImpl: (url: string) => Promise<THREE.Texture>;

  private readonly manifests = new Map<string, Promise<MaterialManifest>>();
  /** Master textures, one per source file: decoded once, never handed out. */
  private readonly sources = new Map<string, Promise<THREE.Texture>>();
  /** Reference-counted instances, one per (file, transform) pair. */
  private readonly instances = new Map<string, TextureEntry>();
  private readonly listeners = new Set<(stats: MaterialRegistryStats) => void>();

  private ktx2Loader: KTX2Loader | null = null;
  private ktx2Probe: Promise<KTX2Loader | null> | null = null;
  private pending = 0;
  private disposed = false;

  constructor(options: MaterialRegistryOptions = {}) {
    this.baseUrl = options.baseUrl;
    this.renderer = options.renderer;
    this.fetchImpl =
      options.fetchImpl ??
      ((input: RequestInfo | URL, init?: RequestInit) => globalThis.fetch(input, init));
    this.loadTextureImpl = options.loadTexture ?? ((url) => this.loadWithThree(url));
  }

  /** Parsed `material.json` for a folder id. Fetched at most once. */
  manifest(id: string): Promise<MaterialManifest> {
    const cached = this.manifests.get(id);
    if (cached) return cached;

    const url = `${materialFolderUrl(id, this.baseUrl)}${MANIFEST_FILENAME}`;
    const promise = this.track(
      this.fetchImpl(url).then(async (response) => {
        if (!response.ok) {
          throw new Error(`material "${id}": ${response.status} fetching ${url}`);
        }
        return parseMaterialManifest(await response.json(), id);
      }),
    );

    this.manifests.set(id, promise);
    return promise;
  }

  /**
   * A texture for one map of one material, configured and reference counted.
   *
   * The returned key must be handed back to {@link release} exactly once. That
   * bookkeeping is the whole leak story: `SlotMaterial` releases every key it
   * holds whenever its binding changes and again when it is disposed.
   */
  async acquire(
    materialId: string,
    source: MapSource,
    transform: TextureTransform = IDENTITY_TRANSFORM,
  ): Promise<AcquiredTexture> {
    const fileKey = `${materialId}/${source.file}`;
    const key = `${fileKey}#${transform.repeat.join(',')}|${transform.offset.join(',')}|${transform.rotation}`;

    const existing = this.instances.get(key);
    if (existing) {
      existing.refs += 1;
      return { key, texture: await existing.promise };
    }

    // The entry is registered before anything is awaited, so two slots asking
    // for the same map at the same moment share one decode and one instance —
    // and a release that lands mid-flight is still counted.
    const entry: TextureEntry = { refs: 1, texture: null, promise: null as never };
    entry.promise = this.loadSource(materialId, fileKey, source).then(
      (master) => {
        const texture = master.clone();
        applyTransform(texture, transform);
        texture.needsUpdate = true;
        entry.texture = texture;
        // Everyone let go while this was decoding: dispose rather than leak a
        // texture nobody will ever ask for again.
        if (this.instances.get(key) !== entry) texture.dispose();
        else this.emit();
        return texture;
      },
      (error: unknown) => {
        // A failed load must not poison the slot for ever: drop the entry so a
        // later attempt re-tries rather than replaying the rejection.
        if (this.instances.get(key) === entry) this.instances.delete(key);
        throw error;
      },
    );
    this.instances.set(key, entry);

    return { key, texture: await entry.promise };
  }

  /** Gives back one reference; the texture is disposed when the last one goes. */
  release(key: string): void {
    const entry = this.instances.get(key);
    if (!entry) return;

    entry.refs -= 1;
    if (entry.refs > 0) return;

    this.instances.delete(key);
    // Null while still decoding — the load's own completion handler disposes
    // it when it notices the entry is gone.
    entry.texture?.dispose();
    this.emit();
  }

  stats(): MaterialRegistryStats {
    return {
      manifests: this.manifests.size,
      sources: this.sources.size,
      textures: this.instances.size,
      pending: this.pending,
      ktx2: this.ktx2Loader !== null,
    };
  }

  /** Notified whenever a load settles or a texture is released. */
  subscribe(listener: (stats: MaterialRegistryStats) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  dispose(): void {
    this.disposed = true;
    for (const entry of this.instances.values()) entry.texture?.dispose();
    this.instances.clear();

    for (const promise of this.sources.values()) {
      void promise.then((texture) => texture.dispose()).catch(() => undefined);
    }
    this.sources.clear();
    this.manifests.clear();
    this.listeners.clear();

    this.ktx2Loader?.dispose();
    this.ktx2Loader = null;
  }

  /**
   * Decodes one file, once.
   *
   * The master is never rendered with — every user gets a clone — so its role
   * is purely to hold the decoded image and the settings that are properties of
   * the *data* rather than of how it is laid on a surface.
   */
  private loadSource(
    materialId: string,
    fileKey: string,
    source: MapSource,
  ): Promise<THREE.Texture> {
    const cached = this.sources.get(fileKey);
    if (cached) return cached;

    const promise = this.track(
      this.resolveUrl(materialId, source).then(async (url) => {
        const texture = await this.loadTextureImpl(url);
        this.configure(texture, source, url);
        return texture;
      }),
    );

    this.sources.set(fileKey, promise);
    return promise;
  }

  /**
   * Everything about a texture that follows from *what it is* rather than from
   * where it is used. Getting any of this wrong is invisible in code review and
   * obvious on screen, which is exactly why none of it is left to a caller.
   */
  private configure(texture: THREE.Texture, source: MapSource, url: string): void {
    // The contract, not a default: colour maps are decoded, data maps are not.
    texture.colorSpace = source.colorSpace === 'srgb' ? THREE.SRGBColorSpace : THREE.NoColorSpace;

    texture.wrapS = THREE.RepeatWrapping;
    texture.wrapT = THREE.RepeatWrapping;
    texture.anisotropy = this.anisotropy();
    texture.generateMipmaps = true;
    texture.minFilter = THREE.LinearMipmapLinearFilter;
    texture.magFilter = THREE.LinearFilter;

    // Compressed containers store their own orientation and cannot be flipped
    // after the fact — three.js warns if you try. The compression script bakes
    // the flip in instead; see `docs/materials.md`.
    if (!url.endsWith('.ktx2')) texture.flipY = true;
    else texture.generateMipmaps = false;
  }

  private anisotropy(): number {
    const capability = this.renderer?.capabilities.getMaxAnisotropy() ?? 1;
    return Math.max(1, Math.min(MAX_ANISOTROPY, capability));
  }

  /** Prefers the KTX2 file when a transcoder is available, else the plain one. */
  private async resolveUrl(materialId: string, source: MapSource): Promise<string> {
    if (source.ktx2 !== undefined && (await this.ktx2())) {
      return materialFileUrl(materialId, source.ktx2, this.baseUrl);
    }
    return materialFileUrl(materialId, source.file, this.baseUrl);
  }

  /**
   * The KTX2 transcoder, or null where it cannot run.
   *
   * Loaded lazily and only when a manifest actually references a `.ktx2` file:
   * the loader plus its wasm payload is a few hundred kilobytes that a project
   * shipping PNGs should never pay for. A failure here is not an error — it
   * means "use the uncompressed file", which is always present.
   */
  private ktx2(): Promise<KTX2Loader | null> {
    if (this.ktx2Probe) return this.ktx2Probe;

    this.ktx2Probe = (async () => {
      if (this.disposed || !this.renderer) return null;
      try {
        const module = await import('three/examples/jsm/loaders/KTX2Loader.js');
        const loader = new module.KTX2Loader()
          .setTranscoderPath(resolveAssetUrl(BASIS_TRANSCODER_PATH, this.baseUrl))
          .detectSupport(this.renderer);
        this.ktx2Loader = loader;
        return loader;
      } catch (error) {
        console.warn('[materials] KTX2 transcoder unavailable; using uncompressed maps', error);
        return null;
      }
    })();

    return this.ktx2Probe;
  }

  private async loadWithThree(url: string): Promise<THREE.Texture> {
    if (url.endsWith('.ktx2')) {
      const loader = await this.ktx2();
      if (loader) return loader.loadAsync(url);
      throw new Error(`no KTX2 transcoder available for ${url}`);
    }
    return new THREE.TextureLoader().loadAsync(url);
  }

  /** Counts a promise as in-flight for {@link stats} and notifies listeners. */
  private track<T>(promise: Promise<T>): Promise<T> {
    this.pending += 1;
    this.emit();
    return promise.finally(() => {
      this.pending -= 1;
      this.emit();
    });
  }

  private emit(): void {
    if (this.listeners.size === 0) return;
    const stats = this.stats();
    for (const listener of [...this.listeners]) listener(stats);
  }
}

function applyTransform(texture: THREE.Texture, transform: TextureTransform): void {
  texture.repeat.set(transform.repeat[0], transform.repeat[1]);
  texture.offset.set(transform.offset[0], transform.offset[1]);
  texture.rotation = transform.rotation;
  texture.center.set(0.5, 0.5);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
}

/**
 * The process-wide registry.
 *
 * `ClockRenderer` builds its own (so it can pass the WebGL context in for
 * transcoder detection and anisotropy), and disposes it. This one exists for
 * the headless unit tests, which construct a `ClockSceneView` with no renderer.
 */
let shared: MaterialRegistry | null = null;

export function sharedMaterialRegistry(): MaterialRegistry {
  shared ??= new MaterialRegistry();
  return shared;
}

/** Test seam: drops the shared registry so a spec starts from a clean cache. */
export function resetSharedMaterialRegistry(): void {
  shared?.dispose();
  shared = null;
}
