/**
 * A scene's handle onto its authored parts.
 *
 * One `AssetLibrary` per active `ClockSceneView`, built from the scene's
 * optional `AssetSpec`. It borrows geometries from the shared
 * {@link AssetRegistry} and hands them out by role; the view uses an authored
 * part where one exists and its generator everywhere else.
 *
 * The load is asynchronous, so {@link part} returns null until the model is in
 * hand — which is exactly the signal a caller needs to fall back to the
 * generator. Nothing here ever throws for a missing or broken model: a failed
 * load is logged once and every `part()` simply keeps returning null, so a scene
 * degrades to fully procedural rather than failing to render.
 *
 * `dispose()` gives the registry its reference back; it never disposes a
 * borrowed geometry — those belong to the registry.
 */

import type * as THREE from 'three';
import { sharedAssetRegistry, type AssetRegistry } from './assetRegistry.js';
import { materialSlotForRole, type PartRole } from './roles.js';
import type { AssetSpec, MaterialSlot } from '../../scene/types.js';

export interface AssetLibraryOptions {
  /** Model cache to draw from. Defaults to the process-wide shared registry. */
  readonly registry?: AssetRegistry;
}

export class AssetLibrary {
  private readonly registry: AssetRegistry;
  private readonly source: string | null;
  private parts: ReadonlyMap<PartRole, THREE.BufferGeometry> | null = null;
  private loading: Promise<void> | null = null;
  private warned = false;
  private disposed = false;

  constructor(spec: AssetSpec | undefined, options: AssetLibraryOptions = {}) {
    this.registry = options.registry ?? sharedAssetRegistry();
    this.source = spec?.source ?? null;

    if (this.source !== null) {
      const source = this.source;
      this.loading = this.registry.acquire(source).then(
        (model) => {
          if (!this.disposed) this.parts = model.parts;
        },
        (error: unknown) => {
          if (!this.warned) {
            this.warned = true;
            console.warn(`[assets] could not load "${source}"; using procedural geometry`, error);
          }
        },
      );
      // Warm cache: `acquire` above still has to be called (it is what the
      // refcount is keyed on), but if the source was already decoded by an
      // earlier `AssetLibrary` its model is sitting in the registry right now.
      // Grabbing it synchronously means `part()` can hand out authored geometry
      // from the very first call — e.g. switching back to a previously loaded
      // scene never renders a procedural frame while the (already-settled)
      // promise above works its way through a microtask.
      const cached = this.registry.peek(source);
      if (cached) this.parts = cached.parts;
    }
  }

  /** True when the scene declared a model to load. */
  get hasSpec(): boolean {
    return this.source !== null;
  }

  /**
   * True while the model is still loading.
   *
   * Polled by the render loop the same way `MaterialLibrary.busy` is: an
   * authored part landing changes what a frame looks like without moving the
   * mechanism, so a held frame must be redrawn when the load settles.
   */
  get busy(): boolean {
    return this.loading !== null && this.parts === null && !this.warned;
  }

  /** Resolves when the model is in hand (or has failed). Never rejects. */
  ready(): Promise<void> {
    return this.loading ?? Promise.resolve();
  }

  /**
   * The authored geometry for a role, or null to use the generator.
   *
   * Null covers every fall-back case with one return value: no model declared,
   * model still loading, model failed, or a role the model does not carry. On a
   * warm cache this can already be non-null right after construction — see the
   * `registry.peek` call above — so a caller must not assume it needs to await
   * {@link ready} first.
   */
  part(role: PartRole): THREE.BufferGeometry | null {
    return this.parts?.get(role) ?? null;
  }

  /** The roles this model actually carries; empty until loaded. */
  availableRoles(): readonly PartRole[] {
    return this.parts ? [...this.parts.keys()] : [];
  }

  /** The material slot a role binds. */
  slotForRole(role: PartRole): MaterialSlot {
    return materialSlotForRole(role);
  }

  dispose(): void {
    // Idempotent: a second call must not decrement the registry's refcount a
    // second time for a reference this library only ever acquired once.
    if (this.disposed) return;
    this.disposed = true;
    if (this.source !== null) this.registry.release(this.source);
    this.parts = null;
  }
}
