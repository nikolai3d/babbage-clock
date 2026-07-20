import * as THREE from 'three';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EnvironmentController, SceneLighting } from './lighting.js';
import { EnvironmentDisposedError } from './ibl/library.js';
import { parseIblManifest } from './ibl/manifest.js';
import { copperPadlockScene } from '../scene/scenes/copperPadlock.js';
import type { EnvironmentSource, LoadedEnvironment } from './ibl/library.js';
import { unlistedPreset } from '../scene/environment.js';
import type { SceneDefinition } from '../scene/types.js';

/**
 * The two properties these tests exist to protect:
 *
 * - **Atomicity.** A mood's environment map, background, light rig and grade
 *   are applied in one synchronous block or not at all. There is no frame in
 *   which the environment comes from one mood and the lights from another.
 * - **Conservation.** Switching moods repeatedly must not accumulate rig
 *   lights, backdrop textures or prefiltered environment maps.
 */

interface FakeEnvironment extends EnvironmentSource {
  readonly cached: Set<string>;
  resolve(id: string): void;
  pendingCount(): number;
  readonly disposed: boolean;
}

const MANIFESTS: Record<string, Record<string, unknown>> = {
  warm: {
    id: 'warm',
    name: 'Warm',
    environment: { file: 'warm.hdr', format: 'rgbe', intensity: 1.5, rotation: 0.4 },
    background: {
      mode: 'fallback',
      blurriness: 0.5,
      intensity: 0.4,
      fallback: { kind: 'gradient', top: '#2a1a10', bottom: '#0a0706', power: 1.5 },
    },
    grade: { exposure: 1.2, toneMapping: 'aces' },
    fog: { color: '#150d09', near: 10, far: 30 },
    lights: [
      { type: 'point', name: 'gaslight', color: '#ffa64d', intensity: 26, position: [-3, 2, 3] },
      { type: 'directional', name: 'rim', color: '#6f8ec4', intensity: 0.5, position: [-5, 3, -6] },
    ],
    source: {
      title: 'W',
      authors: ['A'],
      provider: 'P',
      url: 'https://example.invalid',
      licence: 'CC0-1.0',
    },
  },
  cool: {
    id: 'cool',
    name: 'Cool',
    environment: { file: 'cool.hdr', format: 'rgbe', intensity: 0.85, rotation: 0 },
    background: {
      mode: 'environment',
      blurriness: 0.15,
      intensity: 0.95,
      fallback: { kind: 'color', color: '#334455' },
    },
    grade: { exposure: 0.9, toneMapping: 'agx' },
    lights: [
      {
        type: 'directional',
        name: 'key',
        color: '#eef3fb',
        intensity: 1.1,
        position: [4, 6, 7],
        shadow: { radius: 9, near: 2, far: 17 },
      },
    ],
    source: {
      title: 'C',
      authors: ['A'],
      provider: 'P',
      url: 'https://example.invalid',
      licence: 'CC0-1.0',
    },
  },
};

/** An environment source whose loads only settle when a test says so. */
function fakeEnvironments(): FakeEnvironment {
  const cached = new Set<string>();
  const textures = new Map<string, THREE.Texture>();
  const waiting = new Map<string, (value: LoadedEnvironment) => void>();
  let disposed = false;

  const entryFor = (id: string): LoadedEnvironment => {
    let texture = textures.get(id);
    if (!texture) {
      texture = new THREE.Texture();
      texture.name = `env:${id}`;
      textures.set(id, texture);
    }
    return { manifest: parseIblManifest(MANIFESTS[id] ?? MANIFESTS['warm'], id), texture };
  };

  return {
    cached,
    get liveTargets(): number {
      return cached.size;
    },
    get disposed(): boolean {
      return disposed;
    },
    peek: (id) => (cached.has(id) ? entryFor(id) : null),
    load(id) {
      return new Promise<LoadedEnvironment>((resolve) => {
        waiting.set(id, resolve);
      });
    },
    resolve(id) {
      const settle = waiting.get(id);
      if (!settle) throw new Error(`No pending load for "${id}"`);
      waiting.delete(id);
      cached.add(id);
      settle(entryFor(id));
    },
    pendingCount: () => waiting.size,
    dispose() {
      disposed = true;
      cached.clear();
    },
  };
}

/**
 * `warm` and `cool` are fixtures, not shipped moods: the controller must not
 * care which ids exist, only what a manifest says.
 */
function sceneWith(mood: string, showAsBackground?: boolean): SceneDefinition {
  const preset = unlistedPreset(mood);
  return {
    ...copperPadlockScene,
    lighting: {
      ...copperPadlockScene.lighting,
      exposure: 1.05,
      environment: showAsBackground === undefined ? { preset } : { preset, showAsBackground },
    },
  };
}

let scene: THREE.Scene;
let renderer: { toneMapping: THREE.ToneMapping; toneMappingExposure: number };
let library: FakeEnvironment;
let controller: EnvironmentController;
const lightings: SceneLighting[] = [];

/** Stands in for `ClockRenderer.setScene` rebuilding the view under the mood. */
function rebuildScene(definition: SceneDefinition): SceneLighting {
  lightings.at(-1)?.dispose();
  const lighting = new SceneLighting(scene, definition.lighting);
  lightings.push(lighting);
  controller.apply(definition, lighting);
  return lighting;
}

function rigLights(): THREE.Light[] {
  return scene.children.filter(
    (child): child is THREE.Light => child instanceof THREE.Light && child.name.startsWith('ibl:'),
  );
}

function sceneLights(): THREE.Light[] {
  return scene.children.filter(
    (child): child is THREE.Light => child instanceof THREE.Light && !child.name.startsWith('ibl:'),
  );
}

beforeEach(() => {
  scene = new THREE.Scene();
  renderer = { toneMapping: THREE.ACESFilmicToneMapping, toneMappingExposure: 1 };
  library = fakeEnvironments();
  controller = new EnvironmentController({ renderer, scene, library });
});

afterEach(() => {
  controller.dispose();
  for (const lighting of lightings) lighting.dispose();
  lightings.length = 0;
  vi.restoreAllMocks();
});

describe('SceneLighting', () => {
  it('scales the scene lights a mood takes over, and restores them exactly', () => {
    const lighting = new SceneLighting(scene, copperPadlockScene.lighting);
    const before = sceneLights().map((light) => light.intensity);

    lighting.setAnalyticScale(0);
    expect(sceneLights().every((light) => light.intensity === 0)).toBe(true);

    lighting.setAnalyticScale(1);
    // Scaling from a remembered base, not multiplying in place: repeated
    // scaling must not drift the scene's own look.
    expect(sceneLights().map((light) => light.intensity)).toEqual(before);
    lighting.dispose();
  });
});

describe('EnvironmentController', () => {
  it('does nothing at all for the "none" preset', () => {
    const lighting = rebuildScene(sceneWith('none'));

    expect(scene.environment).toBeNull();
    expect(rigLights()).toHaveLength(0);
    expect(scene.fog).toBeNull();
    expect(renderer.toneMapping).toBe(THREE.ACESFilmicToneMapping);
    expect(renderer.toneMappingExposure).toBeCloseTo(1.05);
    expect(sceneLights().every((light) => light.intensity > 0)).toBe(true);
    expect(lighting).toBeDefined();
  });

  it('leaves the previous look untouched while a mood is still loading', () => {
    rebuildScene(sceneWith('warm'));

    // Nothing has been committed, so the scene must still be exactly what its
    // own lighting config describes — this is why a mood cannot delay a paint.
    expect(scene.environment).toBeNull();
    expect(rigLights()).toHaveLength(0);
    expect(scene.background).toBeInstanceOf(THREE.Color);
    expect(sceneLights().every((light) => light.intensity > 0)).toBe(true);
    expect(renderer.toneMappingExposure).toBeCloseTo(1.05);
    expect(library.pendingCount()).toBe(1);
  });

  it('commits environment, background, rig, fog and grade in one step', async () => {
    rebuildScene(sceneWith('warm'));
    library.resolve('warm');
    await vi.waitFor(() => expect(controller.activeMood).toBe('warm'));

    expect(scene.environment?.name).toBe('env:warm');
    expect(scene.environmentIntensity).toBeCloseTo(1.5);
    expect(scene.environmentRotation.y).toBeCloseTo(0.4);
    expect(rigLights().map((light) => light.name)).toEqual(['ibl:warm:gaslight', 'ibl:warm:rim']);
    expect(scene.fog).toBeInstanceOf(THREE.Fog);
    // Mood grade times the scene's own trim.
    expect(renderer.toneMappingExposure).toBeCloseTo(1.2 * 1.05);
    // The mood owns the lighting, so the scene's own key is dimmed to nothing.
    expect(sceneLights().every((light) => light.intensity === 0)).toBe(true);
  });

  it('applies a mood already in the cache without an intermediate frame', () => {
    library.cached.add('cool');
    rebuildScene(sceneWith('cool'));

    // No await anywhere: everything landed inside `apply`.
    expect(controller.activeMood).toBe('cool');
    expect(scene.environment?.name).toBe('env:cool');
    expect(rigLights()).toHaveLength(1);
    expect(renderer.toneMapping).toBe(THREE.AgXToneMapping);
    expect(library.pendingCount()).toBe(0);
  });

  it('shows the panorama or the fallback backdrop as the scene asks, not the map', () => {
    library.cached.add('cool');

    // `cool` prefers its panorama...
    rebuildScene(sceneWith('cool'));
    expect(scene.background).toBe(scene.environment);
    expect(scene.backgroundBlurriness).toBeCloseTo(0.15);

    // ...but a scene that wants its own vignette keeps it, still lit by the
    // same map. Background treatment is independent of lighting.
    rebuildScene(sceneWith('cool', false));
    expect(scene.background).not.toBe(scene.environment);
    expect(scene.environment?.name).toBe('env:cool');
    expect(scene.background).toBeInstanceOf(THREE.Color);
  });

  it('builds a gradient backdrop and disposes it when the mood moves on', () => {
    library.cached.add('warm');
    library.cached.add('cool');

    rebuildScene(sceneWith('warm'));
    const backdrop = scene.background;
    expect(backdrop).toBeInstanceOf(THREE.DataTexture);

    const disposed = vi.fn();
    (backdrop as THREE.DataTexture).addEventListener('dispose', disposed);

    rebuildScene(sceneWith('cool'));
    // A generated texture nobody disposes is exactly the kind of leak that
    // compounds: one per switch, for as long as the tab is open.
    expect(disposed).toHaveBeenCalledOnce();
    expect(scene.background).not.toBe(backdrop);
  });

  it('reuses the backdrop while the mood stays put', () => {
    library.cached.add('warm');
    rebuildScene(sceneWith('warm'));
    const backdrop = scene.background;

    // A scene switch re-commits the same mood. Regenerating a bit-for-bit
    // identical gradient each time would churn a texture per switch.
    rebuildScene(sceneWith('warm'));
    expect(scene.background).toBe(backdrop);
  });

  it('re-asserts the committed mood over a scene rebuilt beneath it', () => {
    library.cached.add('cool');
    rebuildScene(sceneWith('cool'));

    // A scene switch builds a fresh SceneLighting, which resets the background
    // and adds the new scene's lights at full strength. If the controller did
    // not re-assert, the very next frame would show the mood's environment
    // over the scene's backdrop and double lighting.
    rebuildScene(sceneWith('cool'));

    expect(scene.background).toBe(scene.environment);
    expect(sceneLights().every((light) => light.intensity === 0)).toBe(true);
    expect(rigLights()).toHaveLength(1);
  });

  it('re-sizes a casting key light with the quality tier, and only on a change', () => {
    library.cached.add('cool');
    rebuildScene(sceneWith('cool'));

    const castingLight = (): THREE.DirectionalLight => {
      const light = rigLights().find((candidate) => candidate.castShadow);
      if (!(light instanceof THREE.DirectionalLight)) throw new Error('no casting key light');
      return light;
    };

    // No tier stated: the rig's own high-tier default.
    const before = castingLight();
    expect(before.shadow.mapSize.width).toBe(2048);

    // The tier changed: the rig is rebuilt around the new resolution, and the
    // old lights (and with them the old shadow map) are released.
    controller.setShadowMapSize(1024);
    const after = castingLight();
    expect(after).not.toBe(before);
    expect(after.shadow.mapSize.width).toBe(1024);
    expect(rigLights()).toHaveLength(1);

    // Re-stating the same size must not churn the rig every applyQuality call.
    controller.setShadowMapSize(1024);
    expect(castingLight()).toBe(after);
  });

  it('does not rebuild the rig when set to the default size it already resolved to', () => {
    // A controller built without a shadowMapSize normalises to the rig's
    // high-tier default (2048 = DEFAULT_SHADOW_MAP_SIZE). Setting that same
    // default later must be a no-op, not a needless rig rebuild — before the
    // omitted-default normalisation this compared 2048 against `undefined` and
    // churned the rig.
    library.cached.add('cool');
    rebuildScene(sceneWith('cool'));

    const castingLight = (): THREE.DirectionalLight => {
      const light = rigLights().find((candidate) => candidate.castShadow);
      if (!(light instanceof THREE.DirectionalLight)) throw new Error('no casting key light');
      return light;
    };

    const before = castingLight();
    expect(before.shadow.mapSize.width).toBe(2048);

    controller.setShadowMapSize(2048);
    expect(castingLight()).toBe(before);
  });

  it('discards a load the viewer has already navigated away from', async () => {
    rebuildScene(sceneWith('warm'));
    library.cached.add('cool');
    rebuildScene(sceneWith('cool'));

    expect(controller.activeMood).toBe('cool');

    // The slow first mood finally arrives. Committing it now would silently
    // overwrite the mood the viewer actually chose.
    library.resolve('warm');
    await Promise.resolve();
    await Promise.resolve();

    expect(controller.activeMood).toBe('cool');
    expect(scene.environment?.name).toBe('env:cool');
    expect(rigLights().every((light) => light.name.startsWith('ibl:cool'))).toBe(true);
  });

  it('keeps the current mood whole when the next one fails to load', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    library.cached.add('cool');
    rebuildScene(sceneWith('cool'));

    const failing = { ...library, load: () => Promise.reject(new Error('offline')) };
    const stubborn = new EnvironmentController({ renderer, scene, library: failing });
    stubborn.apply(sceneWith('warm'), lightings.at(-1)!);
    await vi.waitFor(() => expect(warn).toHaveBeenCalled());

    // A half-applied mood would be worse than no change at all.
    expect(scene.environment?.name).toBe('env:cool');
    expect(rigLights().every((light) => light.name.startsWith('ibl:cool'))).toBe(true);
    stubborn.dispose();
  });

  it('settles the status quietly when the library is disposed beneath a load', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    library.cached.add('cool');
    rebuildScene(sceneWith('cool'));

    const tornDown = {
      ...library,
      load: () => Promise.reject(new EnvironmentDisposedError('EnvironmentLibrary is disposed')),
    };
    const survivor = new EnvironmentController({ renderer, scene, library: tornDown });
    survivor.apply(sceneWith('warm'), lightings.at(-1)!);
    await vi.waitFor(() => expect(survivor.status).toBe('none'));

    // The library going away is teardown, not a broken mood: no warning in
    // the console, and the status settles instead of reporting 'loading'
    // forever. What was committed before stays whole on screen.
    expect(warn).not.toHaveBeenCalled();
    expect(scene.environment?.name).toBe('env:cool');
    expect(rigLights().every((light) => light.name.startsWith('ibl:cool'))).toBe(true);
    survivor.dispose();
  });

  it('hands the scene back to its own lighting when the mood becomes "none"', () => {
    library.cached.add('warm');
    rebuildScene(sceneWith('warm'));
    expect(controller.activeMood).toBe('warm');

    rebuildScene(sceneWith('none'));

    expect(controller.activeMood).toBeNull();
    expect(scene.environment).toBeNull();
    expect(scene.environmentIntensity).toBe(1);
    expect(scene.fog).toBeNull();
    expect(rigLights()).toHaveLength(0);
    expect(scene.background).toBeInstanceOf(THREE.Color);
    expect(scene.backgroundBlurriness).toBe(0);
    expect(sceneLights().every((light) => light.intensity > 0)).toBe(true);
    expect(renderer.toneMapping).toBe(THREE.ACESFilmicToneMapping);
    expect(renderer.toneMappingExposure).toBeCloseTo(1.05);
  });

  it('accumulates nothing across repeated mood switching', () => {
    library.cached.add('warm');
    library.cached.add('cool');

    for (let i = 0; i < 8; i += 1) {
      rebuildScene(sceneWith(i % 2 === 0 ? 'warm' : 'cool'));
    }
    rebuildScene(sceneWith('warm'));

    // Nine switches, and the scene holds exactly the last mood's two rig
    // lights plus one scene's own. This is the lighting analogue of the
    // InstancedMesh leak an earlier bead fixed: invisible until it is measured.
    expect(rigLights()).toHaveLength(2);
    expect(sceneLights()).toHaveLength(copperPadlockScene.lighting.directional.length + 1);
    expect(controller.liveEnvironments).toBe(2);
  });

  it('detaches its rig and releases its library on dispose', () => {
    library.cached.add('warm');
    rebuildScene(sceneWith('warm'));
    expect(rigLights()).toHaveLength(2);

    controller.dispose();

    expect(rigLights()).toHaveLength(0);
    expect(scene.environment).toBeNull();
    expect(scene.fog).toBeNull();
    expect(library.disposed).toBe(true);
  });

  it('ignores an apply that arrives after disposal', () => {
    controller.dispose();
    library.cached.add('warm');

    expect(() =>
      controller.apply(sceneWith('warm'), new SceneLighting(scene, copperPadlockScene.lighting)),
    ).not.toThrow();
    expect(controller.activeMood).toBeNull();
  });
});
