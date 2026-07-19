import { describe, expect, it } from 'vitest';
import { SceneRegistry } from './registry.js';
import { validateSceneDefinition } from './validate.js';
import { MATERIAL_SLOTS } from './types.js';
import { COPPER_PADLOCK_SCENE_ID, SLATE_ORRERY_SCENE_ID, sceneRegistry } from './scenes/index.js';
import { copperPadlockScene } from './scenes/copperPadlock.js';
import type { SceneDefinition } from './types.js';

/** A valid scene derived from the shipped preset, with targeted overrides. */
function makeScene(overrides: Partial<SceneDefinition> = {}): SceneDefinition {
  return { ...copperPadlockScene, ...overrides };
}

describe('shipped scenes', () => {
  it('registers both presets and validates them', () => {
    const ids = sceneRegistry.list().map((scene) => scene.id);

    expect(ids).toContain(COPPER_PADLOCK_SCENE_ID);
    expect(ids).toContain(SLATE_ORRERY_SCENE_ID);
    for (const scene of sceneRegistry.list()) {
      expect(validateSceneDefinition(scene)).toEqual([]);
    }
  });

  it('binds every material slot in every scene', () => {
    for (const scene of sceneRegistry.list()) {
      for (const slot of MATERIAL_SLOTS) {
        expect(scene.materials[slot]).toBeDefined();
      }
    }
  });

  /**
   * The gear train is decorative, but it must not be *incoherent*. These are
   * the two things a viewer would notice immediately if they were wrong, and
   * they are properties of the scene data alone — no WebGL needed to check.
   */
  it('counter-rotates meshed neighbours along every train', () => {
    for (const scene of sceneRegistry.list()) {
      // Gears are authored as a chain: each one meshes with the one before it.
      expect(scene.gears.length).toBeGreaterThan(1);

      for (let i = 1; i < scene.gears.length; i += 1) {
        const previous = scene.gears[i - 1]!;
        const gear = scene.gears[i]!;
        expect(Math.sign(gear.angularVelocity)).toBe(-Math.sign(previous.angularVelocity));
      }
    }
  });

  it('spins small wheels faster than large ones', () => {
    for (const scene of sceneRegistry.list()) {
      const byRadius = [...scene.gears].sort((a, b) => a.radius - b.radius);
      for (let i = 1; i < byRadius.length; i += 1) {
        expect(Math.abs(byRadius[i]!.angularVelocity)).toBeLessThan(
          Math.abs(byRadius[i - 1]!.angularVelocity),
        );
      }
    }
  });

  it('meshes each wheel with the next at the sum of their radii', () => {
    for (const scene of sceneRegistry.list()) {
      for (let i = 1; i < scene.gears.length; i += 1) {
        const previous = scene.gears[i - 1]!;
        const gear = scene.gears[i]!;
        const centres = Math.hypot(
          gear.position[0] - previous.position[0],
          gear.position[1] - previous.position[1],
        );
        // Within a couple of centimetres of true contact — close enough that
        // the teeth visibly interleave rather than float apart.
        expect(centres).toBeCloseTo(previous.radius + gear.radius, 1);
        // And the ratio matches the tooth counts, so the picture is consistent.
        expect(Math.abs(gear.angularVelocity / previous.angularVelocity)).toBeCloseTo(
          previous.teeth / gear.teeth,
          2,
        );
      }
    }
  });

  /**
   * The train fills the case *behind* the drums, as in the reference image —
   * which means no wheel may pass through the ring stack. A wheel is a disc in
   * a plane parallel to the drums' axis, so the nearest it comes to that axis
   * is `(|y| - r)` across and `(|z| - t/2)` back; if that point is inside the
   * drum radius, the wheel is cutting through a ring.
   */
  it('keeps every wheel clear of the ring stack', () => {
    for (const scene of sceneRegistry.list()) {
      expect(scene.rings.axis).toBe('x');
      for (const gear of scene.gears) {
        const across = Math.max(0, Math.abs(gear.position[1]) - gear.radius);
        const back = Math.abs(gear.position[2]) - gear.thickness / 2;
        expect(Math.hypot(across, back)).toBeGreaterThan(scene.rings.radius);
      }
    }
  });

  it('drives ring layout from data, not from render code', () => {
    // The whole point of the second preset: a different configuration with no
    // renderer changes. If these ever match, the registry is proving nothing.
    const copper = sceneRegistry.resolve(COPPER_PADLOCK_SCENE_ID);
    const slate = sceneRegistry.resolve(SLATE_ORRERY_SCENE_ID);

    expect(copper.rings.count).not.toBe(slate.rings.count);
  });
});

describe('SceneRegistry', () => {
  it('defaults to the copper padlock preset', () => {
    expect(sceneRegistry.defaultSceneId).toBe(COPPER_PADLOCK_SCENE_ID);
  });

  it('resolves a known ?scene= value', () => {
    expect(sceneRegistry.resolveId(SLATE_ORRERY_SCENE_ID)).toBe(SLATE_ORRERY_SCENE_ID);
  });

  it('falls back to the default for unknown, empty or missing ids', () => {
    for (const input of ['nope', '', null, undefined]) {
      expect(sceneRegistry.resolveId(input)).toBe(COPPER_PADLOCK_SCENE_ID);
    }
    expect(sceneRegistry.resolve('nope').id).toBe(COPPER_PADLOCK_SCENE_ID);
  });

  it('uses the first scene when no default is named', () => {
    const registry = new SceneRegistry([makeScene({ id: 'a' }), makeScene({ id: 'b' })]);

    expect(registry.defaultSceneId).toBe('a');
  });

  it('rejects duplicate ids', () => {
    expect(() => new SceneRegistry([makeScene({ id: 'x' }), makeScene({ id: 'x' })])).toThrow(
      /Duplicate scene id/,
    );
  });

  it('rejects an empty registry and an unregistered default', () => {
    expect(() => new SceneRegistry([])).toThrow(/at least one scene/);
    expect(() => new SceneRegistry([makeScene({ id: 'a' })], 'b')).toThrow(/not registered/);
  });

  it('rejects an invalid scene at construction time', () => {
    const broken = makeScene({
      id: 'broken',
      rings: { ...copperPadlockScene.rings, count: 0 },
    });

    expect(() => new SceneRegistry([broken])).toThrow(/rings.count must be a positive integer/);
  });
});

describe('validateSceneDefinition', () => {
  it('accepts the shipped preset', () => {
    expect(validateSceneDefinition(copperPadlockScene)).toEqual([]);
  });

  it('flags rings that would intersect', () => {
    const scene = makeScene({
      rings: { ...copperPadlockScene.rings, spacing: 0.1, thickness: 0.5 },
    });

    expect(validateSceneDefinition(scene).join('\n')).toMatch(/would intersect/);
  });

  it('flags a gear with a zero-length rotation axis', () => {
    const scene = makeScene({
      gears: [{ ...copperPadlockScene.gears[0]!, axis: [0, 0, 0] }],
    });

    expect(validateSceneDefinition(scene).join('\n')).toMatch(/zero-length rotation axis/);
  });

  it('flags duplicate gear ids', () => {
    const gear = copperPadlockScene.gears[0]!;
    const scene = makeScene({ gears: [gear, gear] });

    expect(validateSceneDefinition(scene).join('\n')).toMatch(/duplicate gear id/);
  });

  it('flags a separator placed outside the digit-ring range', () => {
    const scene = makeScene({
      rings: { ...copperPadlockScene.rings, separators: [{ afterRing: 9 }] },
    });

    expect(validateSceneDefinition(scene).join('\n')).toMatch(/separator afterRing must be/);
  });

  it('flags inverted camera limits', () => {
    const scene = makeScene({
      camera: { ...copperPadlockScene.camera, minDistance: 20, maxDistance: 5 },
    });

    expect(validateSceneDefinition(scene).join('\n')).toMatch(/maxDistance must exceed/);
  });

  it('reports every problem at once rather than stopping at the first', () => {
    const scene = makeScene({
      id: 'multi',
      rings: { ...copperPadlockScene.rings, count: -1, radius: 0 },
    });

    expect(validateSceneDefinition(scene).length).toBeGreaterThan(1);
  });
});
