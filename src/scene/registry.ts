import { assertValidScene } from './validate.js';
import type { SceneDefinition } from './types.js';

/**
 * Ordered, validated collection of switchable scenes.
 *
 * Held as a class rather than module-level mutable state so tests can build
 * throwaway registries without leaking into each other.
 */
export class SceneRegistry {
  private readonly scenes = new Map<string, SceneDefinition>();
  readonly defaultSceneId: string;

  constructor(scenes: readonly SceneDefinition[], defaultSceneId?: string) {
    if (scenes.length === 0) throw new Error('SceneRegistry requires at least one scene');

    for (const scene of scenes) {
      if (this.scenes.has(scene.id)) throw new Error(`Duplicate scene id "${scene.id}"`);
      assertValidScene(scene);
      this.scenes.set(scene.id, scene);
    }

    const fallbackId = scenes[0]!.id;
    if (defaultSceneId !== undefined && !this.scenes.has(defaultSceneId)) {
      throw new Error(`Default scene "${defaultSceneId}" is not registered`);
    }
    this.defaultSceneId = defaultSceneId ?? fallbackId;
  }

  has(id: string): boolean {
    return this.scenes.has(id);
  }

  /** Returns `undefined` for unknown ids; use `resolve` when you need a scene. */
  get(id: string): SceneDefinition | undefined {
    return this.scenes.get(id);
  }

  /** Registration order, which is also the order the UI lists them in. */
  list(): SceneDefinition[] {
    return [...this.scenes.values()];
  }

  /** Maps an untrusted id (e.g. from `?scene=`) onto a scene, never failing. */
  resolveId(requested: string | null | undefined): string {
    return requested && this.scenes.has(requested) ? requested : this.defaultSceneId;
  }

  resolve(requested: string | null | undefined): SceneDefinition {
    return this.scenes.get(this.resolveId(requested))!;
  }
}
