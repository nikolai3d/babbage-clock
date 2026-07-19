import * as THREE from 'three';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ClockSceneView } from './clockScene.js';
import { MaterialLibrary } from './materials.js';
import { AssetLibrary } from './assets/assetLibrary.js';
import { AssetRegistry } from './assets/assetRegistry.js';
import type { PartRole } from './assets/roles.js';
import { ringAngleForDigit, ringAxisOffset, ringStackSlots } from '../geometry/ringLayout.js';
import { copperPadlockScene } from '../scene/scenes/copperPadlock.js';
import { slateOrreryScene } from '../scene/scenes/slateOrrery.js';
import { MATERIAL_SLOTS, type SceneDefinition } from '../scene/types.js';

/**
 * Scene-graph construction needs no WebGL context — only WebGLRenderer does —
 * so the geometry builder is unit-testable. Actual pixels are covered by the
 * screenshot harness a later bead adds.
 */

let scene: THREE.Scene;

beforeEach(() => {
  scene = new THREE.Scene();
});

afterEach(() => {
  vi.restoreAllMocks();
});

function countMeshes(root: THREE.Object3D): number {
  let total = 0;
  root.traverse((object) => {
    if (object instanceof THREE.Mesh) total += 1;
  });
  return total;
}

/** Feeds the view one countdown frame and draws it, as the renderer does. */
function show(view: ClockSceneView, digits: readonly number[], nowMs: number, sequence = 0): void {
  view.setFrame({ digits, sequence, expired: false, direction: 'down' }, nowMs);
  view.update(nowMs);
}

/** Current rotation of each ring group about the ring axis. */
function ringAngles(view: ClockSceneView): number[] {
  const axis = view.definition.rings.axis;
  return Array.from(
    { length: view.ringCount },
    (_, i) => view.root.getObjectByName(`ring:${i}`)!.rotation[axis],
  );
}

/** A copy of each detent lever's instance matrix. */
function detentMatrices(view: ClockSceneView): number[][] {
  const mesh = view.root.getObjectByName('detents') as THREE.InstancedMesh;
  const matrix = new THREE.Matrix4();
  return Array.from({ length: mesh.count }, (_, i) => {
    mesh.getMatrixAt(i, matrix);
    return [...matrix.elements];
  });
}

/** Triangles and draw calls, counted the way the budget in docs/assets.md is. */
function countBudget(root: THREE.Object3D): { triangles: number; drawCalls: number } {
  let triangles = 0;
  let drawCalls = 0;
  root.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return;
    const geometry = (object as THREE.Mesh<THREE.BufferGeometry>).geometry;
    const vertices =
      geometry.index !== null ? geometry.index.count : geometry.getAttribute('position').count;
    const instances = object instanceof THREE.InstancedMesh ? object.count : 1;
    triangles += (vertices / 3) * instances;
    drawCalls += 1;
  });
  return { triangles: Math.round(triangles), drawCalls };
}

describe('ClockSceneView', () => {
  it('builds one ring group per configured ring', () => {
    const view = new ClockSceneView(scene, copperPadlockScene);

    const ringGroups = view.root.children.filter((child) => child.name.startsWith('ring:'));

    expect(view.ringCount).toBe(copperPadlockScene.rings.count);
    expect(ringGroups).toHaveLength(copperPadlockScene.rings.count);
    view.dispose();
  });

  it('marks every mesh as a shadow caster and receiver', () => {
    // The flags are free until a lighting mood's key light actually casts
    // (see render/ibl/rig.ts); what this protects is completeness — a new part
    // added without them would float, shadowless, under sunny-day.
    const view = new ClockSceneView(scene, copperPadlockScene);

    let meshes = 0;
    view.root.traverse((object) => {
      if (!(object as THREE.Mesh).isMesh) return;
      meshes += 1;
      expect(object.castShadow, `${object.name || object.parent?.name} casts`).toBe(true);
      expect(object.receiveShadow, `${object.name || object.parent?.name} receives`).toBe(true);
    });
    expect(meshes).toBeGreaterThan(0);
    view.dispose();
  });

  it('takes ring count and spacing from the definition, not from code', () => {
    const copper = new ClockSceneView(scene, copperPadlockScene);
    const slate = new ClockSceneView(new THREE.Scene(), slateOrreryScene);

    const ringsOf = (view: ClockSceneView): THREE.Object3D[] =>
      view.root.children.filter((child) => child.name.startsWith('ring:'));

    expect(ringsOf(copper)).toHaveLength(7);
    expect(ringsOf(slate)).toHaveLength(5);

    const [first, second] = ringsOf(slate);
    expect(second!.position.x - first!.position.x).toBeCloseTo(slateOrreryScene.rings.spacing);

    copper.dispose();
    slate.dispose();
  });

  it('centres the ring stack on the origin', () => {
    const view = new ClockSceneView(scene, copperPadlockScene);

    const positions = view.root.children
      .filter((child) => child.name.startsWith('ring:'))
      .map((child) => child.position.x);

    expect(positions[0]! + positions[positions.length - 1]!).toBeCloseTo(0);
    view.dispose();
  });

  it('builds a gear per spec and spins it at the configured rate', () => {
    const view = new ClockSceneView(scene, copperPadlockScene);
    const gearIds = view.root.children
      .filter((child) => child.name.startsWith('gear:'))
      .map((child) => child.name);

    expect(gearIds).toHaveLength(copperPadlockScene.gears.length);

    const spinner = view.root.getObjectByName('gear:gear-a')!.children[0]!;
    show(view, [0, 0, 0, 0, 0, 0, 1], 0);
    show(view, [0, 0, 0, 0, 0, 0, 1], 1000);

    // One second of drive time, one second of rotation.
    expect(spinner.rotation.y).toBeCloseTo(copperPadlockScene.gears[0]!.angularVelocity, 6);
    view.dispose();
  });

  it('drives the train from the clock, not from accumulated frames', () => {
    const view = new ClockSceneView(scene, copperPadlockScene);
    const spinner = view.root.getObjectByName('gear:gear-a')!.children[0]!;

    show(view, [0, 0, 0, 0, 0, 0, 1], 0);
    // The tab sleeps for ten seconds and comes back on a single frame.
    show(view, [0, 0, 0, 0, 0, 0, 1], 10_000);

    expect(spinner.rotation.y).toBeCloseTo(
      (copperPadlockScene.gears[0]!.angularVelocity * 10) % (Math.PI * 2),
      6,
    );
    view.dispose();
  });

  it('rotates rings to the digit they were given', () => {
    const view = new ClockSceneView(scene, copperPadlockScene);
    const ring = view.root.getObjectByName('ring:0')!;

    show(view, [5, 0, 0, 0, 0, 0, 0], 0);

    expect(ring.rotation.x).toBeCloseTo(-5 * ((Math.PI * 2) / 10), 9);
    view.dispose();
  });

  it('rejects a digit array that does not match the ring count', () => {
    const view = new ClockSceneView(scene, copperPadlockScene);

    // Silence is worse than a throw here: a short array used to leave rings
    // showing a stale digit with nothing to say so.
    expect(() => show(view, [1, 2], 0)).toThrow(/expected 7 digits/);
    view.dispose();
  });

  it('adds lights from the definition and removes them on dispose', () => {
    const expected = copperPadlockScene.lighting.directional.length + 1; // + ambient
    const view = new ClockSceneView(scene, copperPadlockScene);

    const lightsBefore = scene.children.filter((child) => child instanceof THREE.Light);
    expect(lightsBefore).toHaveLength(expected);

    view.dispose();

    expect(scene.children.filter((child) => child instanceof THREE.Light)).toHaveLength(0);
    expect(scene.background).toBeNull();
  });

  it('disposes every geometry and material and detaches from the scene', () => {
    const view = new ClockSceneView(scene, copperPadlockScene);

    const geometries = new Set<THREE.BufferGeometry>();
    const materials = new Set<THREE.Material>();
    view.root.traverse((object) => {
      if (!(object instanceof THREE.Mesh)) return;
      // three.js types Mesh generically, so narrow it explicitly.
      const mesh = object as THREE.Mesh<THREE.BufferGeometry, THREE.Material>;
      geometries.add(mesh.geometry);
      if (mesh.material instanceof THREE.Material) materials.add(mesh.material);
    });
    expect(geometries.size).toBeGreaterThan(0);
    expect(materials.size).toBeGreaterThan(0);

    const disposedGeometries = new Set<THREE.BufferGeometry>();
    const disposedMaterials = new Set<THREE.Material>();
    for (const geometry of geometries) {
      geometry.addEventListener('dispose', () => disposedGeometries.add(geometry));
    }
    for (const material of materials) {
      material.addEventListener('dispose', () => disposedMaterials.add(material));
    }

    view.dispose();

    expect(disposedGeometries).toEqual(geometries);
    expect(disposedMaterials).toEqual(materials);
    expect(scene.children).not.toContain(view.root);
    expect(countMeshes(view.root)).toBe(0);
  });

  it('disposes instanced meshes, which own a GPU buffer of their own', () => {
    const view = new ClockSceneView(scene, copperPadlockScene);

    const instanced: THREE.InstancedMesh[] = [];
    view.root.traverse((object) => {
      // three.js types InstancedMesh generically, so narrow it explicitly.
      if (object instanceof THREE.InstancedMesh) instanced.push(object as THREE.InstancedMesh);
    });
    // The bezel screw studs and the detent levers. Gear teeth used to be
    // instanced too; they are now part of the extruded gear profile, so a wheel
    // is a single mesh.
    expect(instanced.map((mesh) => mesh.name).sort()).toEqual(['detents', 'housing:studs']);

    // InstancedMesh.dispose() releases instanceMatrix; disposing the geometry
    // and material alone would leak it on every scene switch.
    const spies = instanced.map((mesh) => vi.spyOn(mesh, 'dispose'));
    view.dispose();

    for (const spy of spies) expect(spy).toHaveBeenCalled();
  });

  it('gives every ring a drum and a set of numerals', () => {
    const view = new ClockSceneView(scene, copperPadlockScene);

    for (let i = 0; i < copperPadlockScene.rings.count; i += 1) {
      const ring = view.root.getObjectByName(`ring:${i}`)!;
      const meshes = ring.children.filter((child) => child instanceof THREE.Mesh);
      expect(meshes).toHaveLength(2);
    }
    view.dispose();
  });

  it('shares one drum and one numeral buffer across the whole stack', () => {
    const view = new ClockSceneView(scene, copperPadlockScene);

    const geometries = new Set<THREE.BufferGeometry>();
    for (let i = 0; i < copperPadlockScene.rings.count; i += 1) {
      const ring = view.root.getObjectByName(`ring:${i}`)!;
      for (const child of ring.children) {
        // three.js types Mesh generically, so narrow it explicitly.
        if (child instanceof THREE.Mesh) {
          geometries.add((child as THREE.Mesh<THREE.BufferGeometry>).geometry);
        }
      }
    }
    // Seven rings, two buffers: the rings differ only by transform.
    expect(geometries.size).toBe(2);
    view.dispose();
  });

  it('builds the case and consumes the frame and bezel slots', () => {
    const view = new ClockSceneView(scene, copperPadlockScene);
    const housing = view.root.getObjectByName('housing')!;

    expect(housing).toBeDefined();
    const names = housing.children.map((child) => child.name);
    expect(names).toContain('housing:case');
    expect(names).toContain('housing:bezel');
    expect(names).toContain('housing:lid');
    expect(names).toContain('housing:shackle');

    const used = new Set<string>();
    housing.traverse((object) => {
      if (object instanceof THREE.Mesh && object.material instanceof THREE.Material) {
        used.add(object.material.name);
      }
    });
    expect(used).toContain('slot:frame');
    expect(used).toContain('slot:bezel');
    view.dispose();
  });

  it('sizes the case around everything the scene contains', () => {
    const view = new ClockSceneView(scene, copperPadlockScene);
    const shell = view.root.getObjectByName('housing:case') as THREE.Mesh;
    shell.geometry.computeBoundingSphere();

    const furthestGear = Math.max(
      ...copperPadlockScene.gears.map(
        (gear) => Math.hypot(gear.position[0], gear.position[1]) + gear.radius,
      ),
    );
    expect(shell.geometry.boundingSphere!.radius).toBeGreaterThan(furthestGear);
    view.dispose();
  });

  /**
   * The property this geometry work exists to protect: a variant that changes
   * only scene data must render without a single code change here.
   */
  it('builds a six-ring clock variant from scene data alone', () => {
    const sixRing: SceneDefinition = {
      ...copperPadlockScene,
      id: 'six-ring',
      mode: 'clock',
      rings: { ...copperPadlockScene.rings, count: 6, radius: 0.8, thickness: 0.3, spacing: 0.4 },
    };

    const view = new ClockSceneView(scene, sixRing);
    show(view, [1, 2, 3, 4, 5, 6], 0);

    expect(view.ringCount).toBe(6);
    expect(view.root.children.filter((child) => child.name.startsWith('ring:'))).toHaveLength(6);

    const drum = view.root.getObjectByName('ring:0')!.children[0] as THREE.Mesh;
    drum.geometry.computeBoundingBox();
    // Sized from the new config, not from the preset it was copied from.
    expect(drum.geometry.boundingBox!.max.y).toBeCloseTo(0.8, 6);

    view.dispose();
  });

  it('survives repeated build/dispose cycles, as scene switching requires', () => {
    for (let i = 0; i < 5; i += 1) {
      const definition = i % 2 === 0 ? copperPadlockScene : slateOrreryScene;
      const view = new ClockSceneView(scene, definition);
      show(view, new Array<number>(definition.rings.count).fill(0), i * 1000);
      view.dispose();
    }

    expect(scene.children).toHaveLength(0);
  });
});

/**
 * The authored-geometry path: a scene with an `AssetSpec` builds from the
 * generators synchronously (the model loads asynchronously) and swaps the
 * authored parts in once it is in hand. Real glTF decode is an e2e concern; here
 * the model loader is faked so the resolution, disposal and animation contract
 * is checkable headlessly.
 */
describe('ClockSceneView with authored geometry', () => {
  const authoredScene: SceneDefinition = {
    ...copperPadlockScene,
    id: 'authored-test',
    assets: { source: 'model.glb' },
  };

  /** A registry whose model resolves (on a microtask) to boxes for `roles`. */
  function withAuthored(roles: PartRole[]): {
    registry: AssetRegistry;
    geometries: Map<PartRole, THREE.BufferGeometry>;
  } {
    const geometries = new Map<PartRole, THREE.BufferGeometry>();
    for (const role of roles) {
      const geometry = new THREE.BoxGeometry(1, 1, 1);
      geometry.name = `authored:${role}`;
      geometries.set(role, geometry);
    }
    const registry = new AssetRegistry({
      loadModel: () => Promise.resolve({ parts: geometries }),
    });
    return { registry, geometries };
  }

  it('builds from generators synchronously, then swaps the authored parts in', async () => {
    const { registry, geometries } = withAuthored(['ring-body', 'detent-lever']);
    const view = new ClockSceneView(scene, authoredScene, { assets: registry });

    // The model loads on a microtask, so the constructor builds from the
    // generators — the first frame is never blocked on a download.
    const bodyMesh = view.root
      .getObjectByName('ring:0')!
      .children.find((child): child is THREE.Mesh => child instanceof THREE.Mesh)!;
    const generatorBody = bodyMesh.geometry;
    expect(generatorBody).not.toBe(geometries.get('ring-body'));
    const generatorDisposed = vi.spyOn(generatorBody, 'dispose');

    await view.assetsReady();

    // Every ring shares the one authored drum; the replaced generator is disposed.
    expect(bodyMesh.geometry).toBe(geometries.get('ring-body'));
    expect(generatorDisposed).toHaveBeenCalledOnce();
    // The instanced detent levers swap too.
    const detents = view.root.getObjectByName('detents') as THREE.InstancedMesh;
    expect(detents.geometry).toBe(geometries.get('detent-lever'));

    view.dispose();
  });

  it('leaves the parts a model omits on their generators', async () => {
    const { registry, geometries } = withAuthored(['ring-body']);
    const view = new ClockSceneView(scene, authoredScene, { assets: registry });
    await view.assetsReady();

    // The model carried no case shell, so its generator geometry stands.
    const shell = view.root.getObjectByName('housing:case') as THREE.Mesh;
    expect([...geometries.values()]).not.toContain(shell.geometry);
    expect(shell.geometry.getAttribute('position').count).toBeGreaterThan(24);

    view.dispose();
  });

  it('borrows authored geometry: the view never disposes it; the registry does when released', async () => {
    const { registry, geometries } = withAuthored(['ring-body', 'gearA', 'balance']);
    // A second holder keeps the model alive past the view's release, which
    // separates "the view disposed it" from "the registry disposed it".
    const keepAlive = new AssetLibrary(authoredScene.assets, { registry });
    await keepAlive.ready();

    const view = new ClockSceneView(scene, authoredScene, { assets: registry });
    await view.assetsReady();

    const disposed = [...geometries.values()].map((geometry) => vi.spyOn(geometry, 'dispose'));
    view.dispose();
    for (const spy of disposed) expect(spy).not.toHaveBeenCalled();

    keepAlive.dispose();
    for (const spy of disposed) expect(spy).toHaveBeenCalledOnce();
  });

  it('drives authored geometry with the same angles as the procedural scene', async () => {
    const { registry } = withAuthored([
      'ring-body',
      'numerals',
      'gearA',
      'balance',
      'detent-lever',
    ]);
    const authored = new ClockSceneView(scene, authoredScene, { assets: registry, motion: false });
    await authored.assetsReady();
    const plain = new ClockSceneView(new THREE.Scene(), copperPadlockScene, { motion: false });

    const digits = Array.from({ length: authored.ringCount }, (_, i) => (i * 3) % 10);
    show(authored, digits, 5000);
    show(plain, digits, 5000);

    // Geometry is authored; motion is unchanged — the mechanism drives the same
    // group rotations either way.
    expect(ringAngles(authored)).toEqual(ringAngles(plain));

    authored.dispose();
    plain.dispose();
  });
});

/**
 * The `?nomotion` half of the determinism contract. The other half (a pinned
 * clock) lives in `src/app/testHooks.test.ts`; together they are what make the
 * screenshot baselines reproducible.
 *
 * Carried over from the testing bead and rewritten against the mechanism API:
 * the assertions are the same, but a frame is now an instant rather than a
 * delta, and rings are fed a whole reading rather than raw digits.
 */
describe('ClockSceneView motion', () => {
  it('eases rings towards their digit over several frames by default', () => {
    const view = new ClockSceneView(scene, copperPadlockScene);
    show(view, [0, 0, 0, 0, 0, 0, 0], 0);

    const event = view.setFrame(
      { digits: [5, 5, 5, 5, 5, 5, 5], sequence: 1, expired: false, direction: 'down' },
      1000,
    )!;
    view.update(1000 + event.durationMs * 0.25);
    const partWay = ringAngles(view);

    // Part of the way there, not all of it: that is the easing.
    expect(partWay[0]).not.toBe(0);
    expect(partWay[0]).not.toBeCloseTo(ringAngleForDigit(5), 3);
    expect(Math.abs(partWay[0] ?? 0)).toBeLessThan(Math.PI);

    view.dispose();
  });

  it('mirrors the group rotations through appliedRingAngles, mid-flight and at rest', () => {
    // The `?testApi` travel probe trusts `appliedRingAngles` as "what the
    // viewer sees" (see `getRingAngles` in renderer.ts). That is only honest
    // while the cached array and the actual group rotations are written
    // together in `update` — this pins them to each other so splitting them
    // apart cannot pass unnoticed.
    const view = new ClockSceneView(scene, copperPadlockScene);
    show(view, [0, 0, 0, 0, 0, 0, 0], 0);

    const event = view.setFrame(
      { digits: [5, 5, 5, 5, 5, 5, 5], sequence: 1, expired: false, direction: 'down' },
      1000,
    )!;

    view.update(1000 + event.durationMs * 0.5);
    expect(view.appliedRingAngles).toEqual(ringAngles(view));
    // Genuinely mid-flight, so the mirror above is tested against a moving
    // ring and not just a settled one — a view that snapped on the first frame
    // would otherwise satisfy every other assertion here.
    expect(view.appliedRingAngles[0]).not.toBe(ringAngleForDigit(5));

    view.update(1000 + event.durationMs + 1);
    expect(view.appliedRingAngles).toEqual(ringAngles(view));
    // At rest the mechanism holds the canonical digit angle *exactly* — the
    // invariant the travel e2e spec's exact-equality assertions lean on.
    expect(view.appliedRingAngles[0]).toBe(ringAngleForDigit(5));

    view.dispose();
  });

  it('snaps rings to their digit in a single frame with motion off', () => {
    const view = new ClockSceneView(scene, copperPadlockScene, { motion: false });
    show(view, [0, 0, 0, 0, 0, 0, 0], 0);

    view.setFrame(
      { digits: [5, 5, 5, 5, 5, 5, 5], sequence: 1, expired: false, direction: 'down' },
      1000,
    );
    view.update(1000);
    const afterOneFrame = ringAngles(view);
    view.update(1500);
    const afterALongFrame = ringAngles(view);

    // Frame-rate independent: the angle depends only on the digit.
    expect(afterALongFrame).toEqual(afterOneFrame);
    expect(afterOneFrame[0]).toBeCloseTo(-Math.PI, 5);

    view.dispose();
  });

  it('keeps gears still with motion off and turning by default', () => {
    const gearRotation = (view: ClockSceneView): number => {
      const gear = view.root.children.find((child) => child.name.startsWith('gear:'));
      return gear?.children[0]?.rotation.y ?? Number.NaN;
    };

    const moving = new ClockSceneView(scene, copperPadlockScene);
    show(moving, [0, 0, 0, 0, 0, 0, 0], 0);
    moving.update(500);
    expect(gearRotation(moving)).not.toBe(0);
    moving.dispose();

    const still = new ClockSceneView(scene, copperPadlockScene, { motion: false });
    show(still, [0, 0, 0, 0, 0, 0, 0], 0);
    still.update(500);
    expect(gearRotation(still)).toBe(0);
    still.dispose();
  });
});

describe('ClockSceneView — update reports whether anything moved', () => {
  /**
   * The renderer skips redrawing when `update` returns false, so this contract
   * is what makes a frozen `?mockNow` capture bit-stable: the mechanism is a
   * pure function of the instant, and a repeated instant must reach a fixed
   * point rather than report phantom motion.
   */
  it('reaches a fixed point under a frozen clock', () => {
    const view = new ClockSceneView(scene, copperPadlockScene);
    view.setFrame(
      { digits: [0, 9, 9, 5, 9, 5, 9], sequence: 0, expired: false, direction: 'down' },
      1_000,
    );

    expect(view.update(1_000)).toBe(true);
    expect(view.update(1_000)).toBe(false);
    expect(view.update(1_000)).toBe(false);

    view.dispose();
  });

  it('reports motion again when the clock advances', () => {
    const view = new ClockSceneView(scene, copperPadlockScene);
    view.setFrame(
      { digits: [0, 9, 9, 5, 9, 5, 9], sequence: 0, expired: false, direction: 'down' },
      1_000,
    );
    view.update(1_000);

    // The drive train turns continuously, so any later instant is a new pose.
    expect(view.update(1_500)).toBe(true);

    view.dispose();
  });

  it('reports a new frame even at the same instant', () => {
    // A target change with the clock frozen: the instant repeats, but the
    // rings must still travel — and the renderer must still draw it.
    const view = new ClockSceneView(scene, copperPadlockScene, { motion: false });
    view.setFrame(
      { digits: [0, 0, 0, 0, 0, 0, 0], sequence: 0, expired: false, direction: 'down' },
      1_000,
    );
    view.update(1_000);

    view.setFrame(
      { digits: [1, 2, 3, 4, 5, 6, 7], sequence: 1, expired: false, direction: 'down' },
      1_000,
    );
    expect(view.update(1_000)).toBe(true);

    view.dispose();
  });
});

describe('ClockSceneView — the mechanism', () => {
  it('reports the digits it is displaying, for the e2e test hooks', () => {
    const view = new ClockSceneView(scene, copperPadlockScene);
    show(view, [0, 9, 9, 5, 9, 5, 9], 0);

    expect(view.displayedDigits).toEqual([0, 9, 9, 5, 9, 5, 9]);
    view.dispose();
  });

  it('turns every carried ring at once on a cascade', () => {
    const view = new ClockSceneView(scene, copperPadlockScene);
    show(view, [1, 0, 0, 0, 0, 0, 0], 0);

    const event = view.setFrame(
      { digits: [0, 9, 9, 5, 9, 5, 9], sequence: 1, expired: false, direction: 'down' },
      1000,
    )!;
    expect(event.motions).toHaveLength(7);

    // Part way through, every ring is between its old and new angle at once.
    view.update(1000 + event.durationMs / 2);
    const midway = ringAngles(view);
    view.update(1000 + event.durationMs + 1);
    const settled = ringAngles(view);

    for (let i = 0; i < 7; i += 1) {
      expect(midway[i]).not.toBe(settled[i]);
      expect(settled[i]).toBeCloseTo(ringAngleForDigit([0, 9, 9, 5, 9, 5, 9][i]!), 9);
    }
    view.dispose();
  });

  it('rocks the detent of a turning ring and leaves the others seated', () => {
    const view = new ClockSceneView(scene, copperPadlockScene);
    show(view, [0, 0, 0, 0, 0, 0, 1], 0);
    const seated = detentMatrices(view);

    const event = view.setFrame(
      { digits: [0, 0, 0, 0, 0, 0, 0], sequence: 1, expired: false, direction: 'down' },
      1000,
    )!;
    view.update(1000 + event.durationMs / 2);
    const lifted = detentMatrices(view);

    // Only the seconds lever moved.
    for (let i = 0; i < 6; i += 1) expect(lifted[i]).toEqual(seated[i]);
    expect(lifted[6]).not.toEqual(seated[6]);

    view.update(1000 + event.durationMs + 1);
    expect(detentMatrices(view)[6]).toEqual(seated[6]);
    view.dispose();
  });

  it('keeps something moving between ticks, and stops it all at expiry', () => {
    const view = new ClockSceneView(scene, copperPadlockScene);
    const balance = view.root.getObjectByName('escapement:balance:spinner')!;
    show(view, [0, 0, 0, 0, 0, 0, 1], 0);

    view.update(60);
    const first = balance.rotation.y;
    view.update(160);
    expect(balance.rotation.y).not.toBe(first);

    view.setFrame(
      { digits: [0, 0, 0, 0, 0, 0, 0], sequence: 1, expired: true, direction: 'down' },
      1000,
    );
    view.update(1000 + 5000);
    const stopped = balance.rotation.y;
    view.update(1000 + 9000);

    expect(balance.rotation.y).toBe(stopped);
    // Come to rest centred, not frozen mid-swing.
    expect(Math.abs(stopped)).toBe(0);
    view.dispose();
  });

  it('freezes completely when motion is disabled', () => {
    const view = new ClockSceneView(scene, copperPadlockScene, { motion: false });
    show(view, [0, 0, 0, 0, 0, 0, 1], 0);

    view.setFrame(
      { digits: [0, 0, 0, 0, 0, 0, 0], sequence: 1, expired: false, direction: 'down' },
      1000,
    );
    view.update(1000);
    const immediate = ringAngles(view);
    // Snapped, not eased: the target angle is reached on the same frame.
    expect(immediate[6]).toBeCloseTo(ringAngleForDigit(0), 9);

    view.update(1500);
    expect(ringAngles(view)).toEqual(immediate);
    expect(view.root.getObjectByName('gear:gear-a')!.children[0]!.rotation.y).toBe(0);
    view.dispose();
  });

  it('builds the escapement and consumes the frame and bezel slots with it', () => {
    const view = new ClockSceneView(scene, copperPadlockScene);
    const escapement = view.root.getObjectByName('escapement')!;

    const names = escapement.children.map((child) => child.name);
    expect(names).toContain('escapement:balance');
    expect(names).toContain('escapement:escape-wheel');
    expect(names).toContain('escapement:cock');

    const used = new Set<string>();
    escapement.traverse((object) => {
      if (object instanceof THREE.Mesh && object.material instanceof THREE.Material) {
        used.add(object.material.name);
      }
    });
    expect(used).toContain('slot:frame');
    expect(used).toContain('slot:bezel');
    view.dispose();
  });

  it('puts the movement behind the drums, inside the case', () => {
    const view = new ClockSceneView(scene, copperPadlockScene);
    const shell = view.root.getObjectByName('housing:case') as THREE.Mesh;
    shell.geometry.computeBoundingBox();
    const back = shell.geometry.boundingBox!.min.z;

    const balance = view.root.getObjectByName('escapement:balance')!;
    // Clear of the drums (which reach z = -radius) and clear of the case back.
    expect(balance.position.z).toBeLessThan(-copperPadlockScene.rings.radius);
    expect(balance.position.z).toBeGreaterThan(back);

    for (const gear of copperPadlockScene.gears) {
      expect(gear.position[2]).toBeLessThan(-copperPadlockScene.rings.radius);
      expect(gear.position[2]).toBeGreaterThan(back);
    }
    view.dispose();
  });
});

describe('ClockSceneView — budgets and framing', () => {
  it('stays inside the documented triangle and draw-call budget', () => {
    for (const definition of [copperPadlockScene, slateOrreryScene]) {
      const view = new ClockSceneView(new THREE.Scene(), definition);
      const { triangles, drawCalls } = countBudget(view.root);

      expect(triangles).toBeLessThan(150_000);
      expect(drawCalls).toBeLessThan(40);
      view.dispose();
    }
  });

  /**
   * Framing is a property, not a taste: the case body has to project inside
   * the frustum from the camera the scene declares. The open lid is excluded —
   * it deliberately runs off the edge, as in the reference image.
   */
  it('frames the whole case body from the scene camera', () => {
    for (const definition of [copperPadlockScene, slateOrreryScene]) {
      const view = new ClockSceneView(new THREE.Scene(), definition);
      view.root.updateMatrixWorld(true);

      for (const aspect of [16 / 9, 4 / 3, 1]) {
        const camera = new THREE.PerspectiveCamera(
          definition.camera.fov,
          aspect,
          definition.camera.near,
          definition.camera.far,
        );
        camera.position.set(...definition.camera.position);
        camera.lookAt(new THREE.Vector3(...definition.camera.target));
        camera.updateMatrixWorld(true);

        const vertex = new THREE.Vector3();
        let worstX = 0;
        let worstY = 0;
        view.root.traverse((object) => {
          if (!(object instanceof THREE.Mesh)) return;
          if (object.name === 'housing:lid' || object.name === 'housing:hinge') return;
          const position = (object as THREE.Mesh<THREE.BufferGeometry>).geometry.getAttribute(
            'position',
          );
          for (let i = 0; i < position.count; i += 1) {
            vertex.fromBufferAttribute(position, i).applyMatrix4(object.matrixWorld);
            vertex.project(camera);
            worstX = Math.max(worstX, Math.abs(vertex.x));
            worstY = Math.max(worstY, Math.abs(vertex.y));
          }
        });

        expect(worstY).toBeLessThan(1);
        expect(worstX).toBeLessThan(1);
        // And it fills the frame rather than sitting as a speck in the middle.
        expect(worstY).toBeGreaterThan(0.75);
      }

      const distance = new THREE.Vector3(...definition.camera.position).distanceTo(
        new THREE.Vector3(...definition.camera.target),
      );
      expect(distance).toBeGreaterThanOrEqual(definition.camera.minDistance);
      expect(distance).toBeLessThanOrEqual(definition.camera.maxDistance);
      view.dispose();
    }
  });

  /**
   * The numerals are engraved at `digitAngle` and the rings are turned by
   * `ringAngleForDigit`; that only reads upright if the camera is on the side
   * the reading line faces. For an x-axis stack that is +Z.
   */
  it('keeps the camera on the side the numerals read from', () => {
    for (const definition of [copperPadlockScene, slateOrreryScene]) {
      expect(definition.rings.axis).toBe('x');
      expect(definition.camera.position[2]).toBeGreaterThan(0);
    }
  });
});

describe('MaterialLibrary', () => {
  it('builds a material for every slot', () => {
    const library = new MaterialLibrary(copperPadlockScene.materials);

    for (const slot of MATERIAL_SLOTS) {
      expect(library.get(slot)).toBeInstanceOf(THREE.MeshStandardMaterial);
    }
    library.dispose();
  });

  /**
   * A PBR binding is asynchronous by nature, and the first frame cannot wait
   * for it. The slot therefore renders a plausible neutral surface immediately
   * and upgrades itself in place once the folder arrives — which is also why a
   * hot swap never flashes. The loading half is covered in `materials.test.ts`.
   */
  it('shows a neutral surface immediately for a PBR binding', () => {
    const library = new MaterialLibrary({
      ...copperPadlockScene.materials,
      housing: { kind: 'pbr', textureSet: 'copper-plate', roughness: 0.12 },
    });

    const material = library.get('housing');
    expect(material.roughness).toBe(0.12);
    expect(material.map).toBeNull();
    library.dispose();
  });

  it('throws for a slot that was never built', () => {
    const library = new MaterialLibrary(copperPadlockScene.materials);
    library.dispose();

    expect(() => library.get('housing')).toThrow(/was not built/);
  });
});

describe('gear spoke styles', () => {
  function trianglesIn(scene: THREE.Scene): number {
    let total = 0;
    scene.traverse((node) => {
      const mesh = node as THREE.Mesh;
      if (!mesh.isMesh || !mesh.geometry) return;
      const geometry = mesh.geometry;
      const index = geometry.getIndex();
      total += (index ? index.count : geometry.getAttribute('position').count) / 3;
    });
    return total;
  }

  it('honours a scene-declared style over the index derivation', () => {
    const oneGear = (spokeStyle?: 'crescent') => ({
      ...copperPadlockScene,
      id: 'spoke-style-probe',
      gears: [
        spokeStyle ? { ...copperPadlockScene.gears[0]!, spokeStyle } : copperPadlockScene.gears[0]!,
      ],
    });

    // Index 0 derives spoke5 today; declaring crescent must change the mesh.
    // Triangle count is a blunt but honest proxy: the two spoke patterns
    // punch different cutouts, so equal counts would mean the declaration
    // never reached the generator.
    const styledScene = new THREE.Scene();
    const styled = new ClockSceneView(styledScene, oneGear('crescent'), { motion: false });
    const styledTriangles = trianglesIn(styledScene);
    styled.dispose();

    const derivedScene = new THREE.Scene();
    const derived = new ClockSceneView(derivedScene, oneGear(), { motion: false });
    const derivedTriangles = trianglesIn(derivedScene);
    derived.dispose();

    expect(styledTriangles).not.toBe(derivedTriangles);
  });
});

describe('escapement placement', () => {
  function escapementHolders(view: ClockSceneView) {
    return {
      balance: view.root.getObjectByName('escapement:balance')!,
      cock: view.root.getObjectByName('escapement:cock')!,
      wheel: view.root.getObjectByName('escapement:escape-wheel')!,
    };
  }

  it('honours a scene-declared placement over the case derivation', () => {
    const placed: SceneDefinition = {
      ...copperPadlockScene,
      id: 'escapement-placement-probe',
      escapement: {
        position: [0.4, 0.55, -0.6],
        escapeWheelOffset: [0.12, -0.05, 0.02],
      },
    };

    const view = new ClockSceneView(new THREE.Scene(), placed, { motion: false });
    const { balance, cock, wheel } = escapementHolders(view);

    expect(balance.position.toArray()).toEqual([0.4, 0.55, -0.6]);
    // The cock holds the balance, so it follows the same centre.
    expect(cock.position.toArray()).toEqual([0.4, 0.55, -0.6]);
    // The escape wheel offset is relative to that centre.
    expect(wheel.position.x).toBeCloseTo(0.4 + 0.12, 9);
    expect(wheel.position.y).toBeCloseTo(0.55 - 0.05, 9);
    expect(wheel.position.z).toBeCloseTo(-0.6 + 0.02, 9);
    view.dispose();
  });

  it('falls back per field: a declared centre keeps the derived wheel offset', () => {
    const derivedView = new ClockSceneView(new THREE.Scene(), copperPadlockScene, {
      motion: false,
    });
    const derived = escapementHolders(derivedView);
    const derivedOffset = derived.wheel.position.clone().sub(derived.balance.position);
    derivedView.dispose();
    // A zero delta would make the comparisons below pass vacuously.
    expect(derivedOffset.length()).toBeGreaterThan(0);

    const placed: SceneDefinition = {
      ...copperPadlockScene,
      id: 'escapement-centre-probe',
      escapement: { position: [0.4, 0.55, -0.6] },
    };
    const view = new ClockSceneView(new THREE.Scene(), placed, { motion: false });
    const { balance, wheel } = escapementHolders(view);
    const offset = wheel.position.clone().sub(balance.position);

    expect(balance.position.toArray()).toEqual([0.4, 0.55, -0.6]);
    // Same delta the derivation dealt out for this scene's case.
    expect(offset.x).toBeCloseTo(derivedOffset.x, 9);
    expect(offset.y).toBeCloseTo(derivedOffset.y, 9);
    expect(offset.z).toBeCloseTo(derivedOffset.z, 9);
    view.dispose();
  });

  it('falls back per field the other way: a declared offset keeps the derived centre', () => {
    const derivedView = new ClockSceneView(new THREE.Scene(), copperPadlockScene, {
      motion: false,
    });
    const derivedCentre = escapementHolders(derivedView).balance.position.clone();
    derivedView.dispose();

    const placed: SceneDefinition = {
      ...copperPadlockScene,
      id: 'escapement-offset-probe',
      escapement: { escapeWheelOffset: [0.12, -0.05, 0.02] },
    };
    const view = new ClockSceneView(new THREE.Scene(), placed, { motion: false });
    const { balance, wheel } = escapementHolders(view);

    // The centre still derives from the case…
    expect(balance.position.toArray()).toEqual(derivedCentre.toArray());
    // …while the wheel sits at the declared offset from it.
    expect(wheel.position.x).toBeCloseTo(derivedCentre.x + 0.12, 9);
    expect(wheel.position.y).toBeCloseTo(derivedCentre.y - 0.05, 9);
    expect(wheel.position.z).toBeCloseTo(derivedCentre.z + 0.02, 9);
    view.dispose();
  });
});

describe('separator rings', () => {
  const separatorGroups = (view: ClockSceneView): THREE.Object3D[] =>
    view.root.children.filter((child) => child.name.startsWith('separator:'));

  const meshesOf = (object: THREE.Object3D): THREE.Mesh<THREE.BufferGeometry, THREE.Material>[] =>
    object.children.filter((child) => child instanceof THREE.Mesh) as THREE.Mesh<
      THREE.BufferGeometry,
      THREE.Material
    >[];

  it('adds a static colon drum at each declared boundary, uncounted as a digit ring', () => {
    const view = new ClockSceneView(scene, copperPadlockScene);

    // The default scene declares two colons: HHH|MM and MM|SS.
    expect(separatorGroups(view)).toHaveLength(2);
    // The mechanism still sees exactly `count` rings — no extra digit ring.
    expect(view.ringCount).toBe(copperPadlockScene.rings.count);
    expect(view.root.children.filter((child) => child.name.startsWith('ring:'))).toHaveLength(
      copperPadlockScene.rings.count,
    );
    view.dispose();
  });

  it('renders a separator like a ring: a drum and a mark, sharing the digit buffers', () => {
    const view = new ClockSceneView(scene, copperPadlockScene);

    const [drum, mark] = meshesOf(view.root.getObjectByName('ring:0')!);
    const separators = separatorGroups(view);
    const [sepDrum, sepMark] = meshesOf(separators[0]!);

    // Same two-mesh shape as a digit ring: a drum plus a colon.
    expect(meshesOf(separators[0]!)).toHaveLength(2);
    // Shares the drum buffer with the digit rings; only the mark differs.
    expect(sepDrum!.geometry).toBe(drum!.geometry);
    // Same materials as the digit rings, so a separator matches the wheel style.
    expect(sepDrum!.material).toBe(drum!.material);
    expect(sepMark!.material).toBe(mark!.material);
    // Both colons come off one shared buffer, distinct from the numerals.
    const [, otherMark] = meshesOf(separators[1]!);
    expect(otherMark!.geometry).toBe(sepMark!.geometry);
    expect(sepMark!.geometry).not.toBe(mark!.geometry);
    view.dispose();
  });

  it('seats digit rings and separators at their physical slots', () => {
    const view = new ClockSceneView(scene, copperPadlockScene);
    const { count, spacing, separators, axis } = copperPadlockScene.rings;
    const slots = ringStackSlots(count, separators ?? []);

    slots.forEach((slot, slotIndex) => {
      const name = slot.kind === 'digit' ? `ring:${slot.digitIndex}` : `separator:${slotIndex}`;
      const group = view.root.getObjectByName(name)!;
      expect(group.position[axis]).toBeCloseTo(ringAxisOffset(slotIndex, slots.length, spacing), 9);
    });
    view.dispose();
  });

  it('never rotates a separator, whatever the reading does', () => {
    const view = new ClockSceneView(scene, copperPadlockScene);
    const axis = copperPadlockScene.rings.axis;
    const separators = separatorGroups(view);

    show(view, [1, 2, 3, 4, 5, 6, 7], 0);
    view.update(0);
    // A wholesale re-read spins the digit drums; the colons must not follow.
    show(view, [9, 8, 7, 6, 5, 4, 3], 5000, 5);
    view.update(5200);

    for (const separator of separators) expect(separator.rotation[axis]).toBe(0);
    view.dispose();
  });

  it('gives a separator no detent lever — only digit rings turn', () => {
    const view = new ClockSceneView(scene, copperPadlockScene);
    const detents = view.root.getObjectByName('detents') as THREE.InstancedMesh;

    // One lever per digit ring, none for the two static colons.
    expect(detents.count).toBe(copperPadlockScene.rings.count);
    view.dispose();
  });

  it('leaves a scene that declares no separators unchanged', () => {
    const view = new ClockSceneView(scene, slateOrreryScene);

    expect(separatorGroups(view)).toHaveLength(0);
    expect(view.root.children.filter((child) => child.name.startsWith('ring:'))).toHaveLength(
      slateOrreryScene.rings.count,
    );
    view.dispose();
  });
});
