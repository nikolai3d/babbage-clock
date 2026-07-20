/**
 * Loads authored glTF models and hands out their parts by role.
 *
 * The counterpart of `materialRegistry.ts` for geometry: a model file is fetched
 * and decoded **once**, its meshes are indexed by role, and the resulting
 * `BufferGeometry` per role is **borrowed** by every scene that uses it — never
 * copied per mesh, and never disposed by a view. The registry owns the
 * geometries and disposes them when the last user lets go, exactly as the
 * texture registry owns its textures. Scene switching is a supported runtime
 * action, so a leak here compounds every time the viewer changes their mind.
 *
 * The three.js `GLTFLoader` needs a browser-ish environment, so it is reached
 * through an injectable {@link ModelLoader} seam (defaulting to a real loader,
 * lazily imported). The Node unit suite injects a fake and never decodes a real
 * `.glb`.
 */

import type * as THREE from 'three';
import { resolveAssetUrl } from '../../materials/paths.js';
import { roleForObjectName, type PartRole } from './roles.js';

/** A decoded model: its meshes, indexed by the role each one plays. */
export interface LoadedModel {
  readonly parts: ReadonlyMap<PartRole, THREE.BufferGeometry>;
}

/** How a model URL becomes decoded parts. Injected in tests. */
export type ModelLoader = (
  url: string,
  onProgress?: (loaded: number, total: number) => void,
) => Promise<LoadedModel>;

export interface AssetRegistryOptions {
  /** Overrides the app base; tests point this at a fixture directory. */
  readonly baseUrl?: string;
  /** Injected for tests; defaults to a real `GLTFLoader`-backed loader. */
  readonly loadModel?: ModelLoader;
  /**
   * Called with byte progress per source, for wiring into `LoadingTracker`.
   *
   * Recorded but not yet acted on — same as the counts {@link AssetRegistry.stats}
   * reports: nothing in the app reads either yet. A `LoadingTracker` binding and
   * a `getAssetState` test hook land in the integrate bead.
   */
  readonly onProgress?: (source: string, loaded: number, total: number) => void;
}

export interface AssetRegistryStats {
  /** Distinct model sources fetched (or in flight). */
  readonly models: number;
  /** Loads still in flight. */
  readonly pending: number;
}

interface ModelEntry {
  refs: number;
  /** Shared by every concurrent acquirer of the same source. */
  promise: Promise<LoadedModel>;
  /** Set once the promise settles; null while decoding. */
  model: LoadedModel | null;
}

export class AssetRegistry {
  private readonly baseUrl: string | undefined;
  private readonly loadModelImpl: ModelLoader;
  private readonly onProgress: AssetRegistryOptions['onProgress'];

  private readonly models = new Map<string, ModelEntry>();
  private pending = 0;

  constructor(options: AssetRegistryOptions = {}) {
    this.baseUrl = options.baseUrl;
    this.loadModelImpl = options.loadModel ?? loadModelWithThree;
    this.onProgress = options.onProgress;
  }

  /**
   * A decoded model for a source, reference counted.
   *
   * The returned promise is shared by every acquirer of the same source. The
   * caller must hand the source back to {@link release} exactly once — an
   * `AssetLibrary` acquires on construction and releases on dispose.
   */
  acquire(source: string): Promise<LoadedModel> {
    const existing = this.models.get(source);
    if (existing) {
      existing.refs += 1;
      return existing.promise;
    }

    // Registered before anything is awaited, so two scenes asking for the same
    // model at the same moment share one decode — and a release that lands
    // mid-flight is still counted.
    const entry: ModelEntry = { refs: 1, model: null, promise: null as never };
    const url = resolveAssetUrl(source, this.baseUrl);
    entry.promise = this.track(
      this.loadModelImpl(url, (loaded, total) => this.onProgress?.(source, loaded, total)),
    ).then(
      (model) => {
        entry.model = model;
        // Everyone let go while this was decoding: dispose rather than leak.
        if (this.models.get(source) !== entry) disposeModel(model);
        return model;
      },
      (error: unknown) => {
        // A failed load must not poison the source for ever: drop the entry so a
        // later attempt re-tries rather than replaying the rejection.
        if (this.models.get(source) === entry) this.models.delete(source);
        throw error;
      },
    );
    this.models.set(source, entry);
    return entry.promise;
  }

  /**
   * The already-resolved model for a source, or null if it is not cached — not
   * yet requested, still decoding, or never acquired. A non-null answer means a
   * caller can hand out authored geometry this instant, with no promise
   * microtask between asking and having it in hand.
   */
  peek(source: string): LoadedModel | null {
    return this.models.get(source)?.model ?? null;
  }

  /** Gives back one reference; the model is disposed when the last one goes. */
  release(source: string): void {
    const entry = this.models.get(source);
    if (!entry) return;

    entry.refs -= 1;
    if (entry.refs > 0) return;

    this.models.delete(source);
    // Null while still decoding — the load's completion handler disposes it when
    // it notices the entry is gone.
    if (entry.model) disposeModel(entry.model);
  }

  stats(): AssetRegistryStats {
    return { models: this.models.size, pending: this.pending };
  }

  dispose(): void {
    for (const entry of this.models.values()) {
      if (entry.model) disposeModel(entry.model);
    }
    this.models.clear();
  }

  private track<T>(promise: Promise<T>): Promise<T> {
    this.pending += 1;
    return promise.finally(() => {
      this.pending -= 1;
    });
  }
}

function disposeModel(model: LoadedModel): void {
  for (const geometry of model.parts.values()) geometry.dispose();
}

/**
 * The real loader: fetch and decode a `.glb`, then index every recognised mesh
 * by role with the node's world transform baked into the geometry.
 *
 * Baking the world matrix is what lets a part be authored at its final place (a
 * `table` under the case) *or* centred on its pivot (a gear) with the same rule:
 * a centred part has an identity transform, so baking is a no-op, and an
 * animated part therefore arrives centred exactly as its generator would return
 * it. Lazily imports `GLTFLoader` so the Node unit suite never pulls it in.
 */
const loadModelWithThree: ModelLoader = async (url, onProgress) => {
  const { GLTFLoader } = await import('three/examples/jsm/loaders/GLTFLoader.js');
  const loader = new GLTFLoader();
  const gltf = await loader.loadAsync(url, (event: ProgressEvent) => {
    if (onProgress && event.total > 0) onProgress(event.loaded, event.total);
  });

  const parts = new Map<PartRole, THREE.BufferGeometry>();
  gltf.scene.updateMatrixWorld(true);
  gltf.scene.traverse((object) => {
    const mesh = object as THREE.Mesh;
    if (!mesh.isMesh) return;
    const role = roleForObjectName(mesh.name);
    if (!role) return;
    if (parts.has(role)) {
      console.warn(`[assets] model "${url}" has more than one "${role}"; keeping the first`);
      return;
    }
    const geometry = mesh.geometry.clone();
    geometry.applyMatrix4(mesh.matrixWorld);
    geometry.name = role;
    parts.set(role, geometry);
  });
  return { parts };
};

/**
 * The process-wide registry.
 *
 * `ClockRenderer` uses this shared instance so switching scenes back and forth
 * re-downloads nothing; the headless unit tests inject their own.
 */
let shared: AssetRegistry | null = null;

export function sharedAssetRegistry(): AssetRegistry {
  shared ??= new AssetRegistry();
  return shared;
}

/** Test seam: drops the shared registry so a spec starts from a clean cache. */
export function resetSharedAssetRegistry(): void {
  shared?.dispose();
  shared = null;
}
