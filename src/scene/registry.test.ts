import { describe, expect, it } from 'vitest';
import { SceneRegistry } from './registry.js';
import { validateSceneDefinition } from './validate.js';
import { MATERIAL_SLOTS } from './types.js';
import {
  BABBAGE_ENGINE_SCENE_ID,
  COPPER_PADLOCK_SCENE_ID,
  SLATE_ORRERY_SCENE_ID,
  sceneRegistry,
} from './scenes/index.js';
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
   * The gear train is decorative, but it must not be *incoherent*. Wheels
   * relate in exactly two ways, both recoverable from the data alone: a
   * *meshed* pair sits in one wheel plane at (almost exactly) the sum of its
   * radii, and a *compound* pair shares an arbor — same spot in the wheel
   * plane, offset along the axis, as `babbage-engine`'s back stage is. Every
   * law a viewer would notice broken hangs off those relations, so the tests
   * classify all pairs geometrically rather than assuming the array is a
   * simple chain.
   */
  function gearRelations(scene: SceneDefinition): {
    meshed: [number, number][];
    compound: [number, number][];
  } {
    const meshed: [number, number][] = [];
    const compound: [number, number][] = [];
    const { gears } = scene;
    for (let i = 0; i < gears.length; i += 1) {
      for (let j = i + 1; j < gears.length; j += 1) {
        const a = gears[i]!;
        const b = gears[j]!;
        // Every shipped scene spins its train about a single axis; measure in
        // that plane and along it.
        const [dx, dy, dz] = [0, 1, 2].map((k) => b.position[k]! - a.position[k]!) as [
          number,
          number,
          number,
        ];
        const [ax, ay, az] = a.axis;
        const norm = Math.hypot(ax, ay, az);
        const axial = (dx * ax + dy * ay + dz * az) / norm;
        const planar = Math.sqrt(Math.max(0, dx * dx + dy * dy + dz * dz - axial * axial));
        if (planar < 1e-6 && Math.abs(axial) > 1e-6) compound.push([i, j]);
        else if (Math.abs(axial) < 1e-6 && Math.abs(planar - (a.radius + b.radius)) < 0.05) {
          meshed.push([i, j]);
        } else if (Math.abs(axial) < 1e-6) {
          // Same plane but not meshing: the wheels must not overlap.
          expect(planar).toBeGreaterThan(a.radius + b.radius);
        } else if (Math.abs(axial) < (a.thickness + b.thickness) / 2) {
          // Different planes, but the faces overlap axially: the two-plane
          // layout must not let a back wheel's rim pass through a front
          // wheel, so a skew pair this close still needs planar clearance.
          // A pair axially clear of each other may overlap in plan freely.
          expect(planar).toBeGreaterThan(a.radius + b.radius);
        }
      }
    }
    return { meshed, compound };
  }

  it('counter-rotates every meshed pair in exact tooth ratio', () => {
    for (const scene of sceneRegistry.list()) {
      const { meshed } = gearRelations(scene);
      expect(meshed.length).toBeGreaterThan(0);
      for (const [i, j] of meshed) {
        const a = scene.gears[i]!;
        const b = scene.gears[j]!;
        expect(Math.sign(b.angularVelocity)).toBe(-Math.sign(a.angularVelocity));
        // Teeth pass the contact at the same rate on both wheels — which also
        // means the smaller wheel of every pair spins faster.
        expect(Math.abs(a.angularVelocity) * a.teeth).toBeCloseTo(
          Math.abs(b.angularVelocity) * b.teeth,
          1,
        );
      }
    }
  });

  it('links every wheel into one train, compound arbors co-rotating', () => {
    for (const scene of sceneRegistry.list()) {
      expect(scene.gears.length).toBeGreaterThan(1);
      const { meshed, compound } = gearRelations(scene);

      // A compound pair is two wheels pinned to one arbor: identical angular
      // velocity, sign included.
      for (const [i, j] of compound) {
        expect(scene.gears[j]!.angularVelocity).toBeCloseTo(scene.gears[i]!.angularVelocity, 6);
      }

      // The relations connect the whole train: no floating wheel that meshes
      // with nothing and rides no arbor.
      const parent = scene.gears.map((_, i) => i);
      const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i]!)));
      for (const [i, j] of [...meshed, ...compound]) parent[find(i)] = find(j);
      const roots = new Set(scene.gears.map((_, i) => find(i)));
      expect(roots.size).toBe(1);
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
  it('defaults to the babbage-engine preset', () => {
    expect(sceneRegistry.defaultSceneId).toBe(BABBAGE_ENGINE_SCENE_ID);
  });

  it('resolves a known ?scene= value', () => {
    expect(sceneRegistry.resolveId(SLATE_ORRERY_SCENE_ID)).toBe(SLATE_ORRERY_SCENE_ID);
  });

  it('falls back to the default for unknown, empty or missing ids', () => {
    for (const input of ['nope', '', null, undefined]) {
      expect(sceneRegistry.resolveId(input)).toBe(BABBAGE_ENGINE_SCENE_ID);
    }
    expect(sceneRegistry.resolve('nope').id).toBe(BABBAGE_ENGINE_SCENE_ID);
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

  it('flags a gear with a non-finite phase', () => {
    const scene = makeScene({
      gears: [{ ...copperPadlockScene.gears[0]!, phase: Number.NaN }],
    });

    expect(validateSceneDefinition(scene).join('\n')).toMatch(/phase must be a finite number/);
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

  it('flags an empty assets.source', () => {
    const scene = makeScene({ assets: { source: '' } });

    expect(validateSceneDefinition(scene).join('\n')).toMatch(/assets\.source/);
  });

  it('accepts a populated assets.source', () => {
    const scene = makeScene({ assets: { source: 'assets/models/x.glb' } });

    expect(validateSceneDefinition(scene).some((error) => error.includes('assets'))).toBe(false);
  });

  it('is unaffected by a scene with no assets spec', () => {
    // The shipped preset carries no `assets` field; confirms that omitting it
    // entirely — as opposed to supplying an empty source — is not an error.
    expect(copperPadlockScene.assets).toBeUndefined();
    expect(
      validateSceneDefinition(copperPadlockScene).some((error) => error.includes('assets')),
    ).toBe(false);
  });
});
