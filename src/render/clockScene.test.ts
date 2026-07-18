import * as THREE from 'three';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ClockSceneView } from './clockScene.js';
import { MaterialLibrary } from './materials.js';
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

describe('ClockSceneView', () => {
  it('builds one ring group per configured ring', () => {
    const view = new ClockSceneView(scene, copperPadlockScene);

    const ringGroups = view.root.children.filter((child) => child.name.startsWith('ring:'));

    expect(view.ringCount).toBe(copperPadlockScene.rings.count);
    expect(ringGroups).toHaveLength(copperPadlockScene.rings.count);
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

    const gear = view.root.getObjectByName('gear:gear-a')!;
    const spinner = gear.children[0]!;
    view.update(1);

    expect(spinner.rotation.y).toBeCloseTo(copperPadlockScene.gears[0]!.angularVelocity);
    view.dispose();
  });

  it('rotates rings toward the digit they were given', () => {
    const view = new ClockSceneView(scene, copperPadlockScene);
    const ring = view.root.getObjectByName('ring:0')!;

    view.setDigits([5, 0, 0, 0, 0, 0, 0]);
    // Several large steps let the easing settle on the target angle.
    for (let i = 0; i < 20; i += 1) view.update(0.1);

    expect(ring.rotation.x).toBeCloseTo(-5 * ((Math.PI * 2) / 10), 3);
    view.dispose();
  });

  it('ignores digit arrays shorter than the ring count', () => {
    const view = new ClockSceneView(scene, copperPadlockScene);

    expect(() => {
      view.setDigits([1, 2]);
      view.update(0.016);
    }).not.toThrow();
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
    // The bezel screw studs. Gear teeth used to be instanced too; they are now
    // part of the extruded gear profile, so a wheel is a single mesh.
    expect(instanced).toHaveLength(1);

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
    view.setDigits([1, 2, 3, 4, 5, 6]);
    view.update(0.1);

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
      const view = new ClockSceneView(scene, i % 2 === 0 ? copperPadlockScene : slateOrreryScene);
      view.update(0.016);
      view.dispose();
    }

    expect(scene.children).toHaveLength(0);
  });
});

/**
 * The `?nomotion` half of the determinism contract. The other half (a pinned
 * clock) lives in `src/app/testHooks.test.ts`; together they are what make the
 * screenshot baselines reproducible.
 */
describe('ClockSceneView motion', () => {
  function ringAngles(view: ClockSceneView): number[] {
    const axis = copperPadlockScene.rings.axis;
    return view.root.children
      .filter((child) => child.name.startsWith('ring:'))
      .map((child) => child.rotation[axis]);
  }

  it('eases rings towards their digit over several frames by default', () => {
    const view = new ClockSceneView(scene, copperPadlockScene);
    view.setDigits([5, 5, 5, 5, 5, 5, 5]);

    view.update(0.016);
    const afterOneFrame = ringAngles(view);

    // Part of the way there, not all of it: that is the easing.
    expect(afterOneFrame[0]).not.toBe(0);
    expect(Math.abs(afterOneFrame[0] ?? 0)).toBeLessThan(Math.PI);

    view.dispose();
  });

  it('snaps rings to their digit in a single frame with motion off', () => {
    const view = new ClockSceneView(scene, copperPadlockScene, { motion: false });
    view.setDigits([5, 5, 5, 5, 5, 5, 5]);

    view.update(0.016);
    const afterOneFrame = ringAngles(view);
    view.update(0.5);
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
    moving.update(0.5);
    expect(gearRotation(moving)).not.toBe(0);
    moving.dispose();

    const still = new ClockSceneView(scene, copperPadlockScene, { motion: false });
    still.update(0.5);
    expect(gearRotation(still)).toBe(0);
    still.dispose();
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

  it('falls back to a placeholder for not-yet-loadable PBR bindings', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const library = new MaterialLibrary({
      ...copperPadlockScene.materials,
      housing: { kind: 'pbr', textureSet: 'copper-padlock/housing', roughness: 0.12 },
    });

    expect(library.get('housing').roughness).toBe(0.12);
    expect(warn).toHaveBeenCalledOnce();
    library.dispose();
  });

  it('throws for a slot that was never built', () => {
    const library = new MaterialLibrary(copperPadlockScene.materials);
    library.dispose();

    expect(() => library.get('housing')).toThrow(/was not built/);
  });
});
