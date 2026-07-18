import * as THREE from 'three';
import { MaterialLibrary } from './materials.js';
import { SceneLighting } from './lighting.js';
import type { Axis, GearSpec, RingConfig, SceneDefinition, Vec3 } from '../scene/types.js';

const DIGITS_PER_RING = 10;
const RING_STEP = (Math.PI * 2) / DIGITS_PER_RING;
const TWO_PI = Math.PI * 2;
/** How fast a ring settles on its digit, in units of "fraction closed per second". */
const RING_SETTLE_RATE = 10;

interface RingView {
  readonly group: THREE.Group;
  currentAngle: number;
  targetAngle: number;
}

/**
 * The renderable form of a `SceneDefinition`.
 *
 * Every dimension, count, colour and light comes from the definition — nothing
 * about "seven rings" or "copper" is hardcoded here. Later beads replace the
 * placeholder geometry inside this class without changing its interface.
 *
 * Owns every GPU resource it creates; `dispose()` releases all of them.
 */
export class ClockSceneView {
  readonly root = new THREE.Group();
  readonly definition: SceneDefinition;

  private readonly materials: MaterialLibrary;
  private readonly lighting: SceneLighting;
  private readonly geometries: THREE.BufferGeometry[] = [];
  private readonly rings: RingView[] = [];
  private readonly gears: { spinner: THREE.Object3D; spec: GearSpec }[] = [];

  constructor(scene: THREE.Scene, definition: SceneDefinition) {
    this.definition = definition;
    this.root.name = `scene:${definition.id}`;

    this.materials = new MaterialLibrary(definition.materials);
    this.lighting = new SceneLighting(scene, definition.lighting);

    this.buildRings(definition.rings);
    this.buildArborAndCaps(definition.rings);
    for (const gear of definition.gears) this.buildGear(gear);

    scene.add(this.root);
  }

  get ringCount(): number {
    return this.definition.rings.count;
  }

  /** Sets the digit each ring should settle on. Extra digits are ignored. */
  setDigits(digits: readonly number[]): void {
    for (let i = 0; i < this.rings.length; i += 1) {
      const ring = this.rings[i];
      const digit = digits[i];
      if (!ring || digit === undefined) continue;
      ring.targetAngle = -digit * RING_STEP;
    }
  }

  /** Advances animation. `dt` is seconds since the previous frame. */
  update(dt: number): void {
    const settle = Math.min(1, dt * RING_SETTLE_RATE);
    const axis = this.definition.rings.axis;

    for (const ring of this.rings) {
      const delta = shortestAngle(ring.targetAngle - ring.currentAngle);
      ring.currentAngle += delta * settle;
      ring.group.rotation[axis] = ring.currentAngle;
    }

    for (const { spinner, spec } of this.gears) {
      // Wrapped rather than accumulated: a tab left open for days would
      // otherwise grow the angle until float precision makes rotation visibly
      // jitter.
      spinner.rotation.y = (spinner.rotation.y + spec.angularVelocity * dt) % TWO_PI;
    }
  }

  dispose(): void {
    this.root.removeFromParent();
    this.root.clear();

    for (const geometry of this.geometries) geometry.dispose();
    this.geometries.length = 0;

    this.rings.length = 0;
    this.gears.length = 0;

    this.lighting.dispose();
    this.materials.dispose();
  }

  private track<T extends THREE.BufferGeometry>(geometry: T): T {
    this.geometries.push(geometry);
    return geometry;
  }

  private buildRings(config: RingConfig): void {
    const { count, radius, thickness, spacing, axis, radialSegments } = config;

    const body = this.track(new THREE.CylinderGeometry(radius, radius, thickness, radialSegments));
    alignGeometryToAxis(body, axis);

    const markSize = radius * 0.16;
    const mark = this.track(new THREE.BoxGeometry(...axisDims(axis, thickness * 0.55, markSize)));

    const bodyMaterial = this.materials.get(config.slot);
    const markMaterial = this.materials.get(config.markSlot);
    const markAxis = perpendicularAxis(axis);

    for (let i = 0; i < count; i += 1) {
      const group = new THREE.Group();
      group.name = `ring:${i}`;
      group.position[axis] = (i - (count - 1) / 2) * spacing;

      group.add(new THREE.Mesh(body, bodyMaterial));

      const markMesh = new THREE.Mesh(mark, markMaterial);
      markMesh.position[markAxis] = radius + markSize * 0.35;
      group.add(markMesh);

      this.root.add(group);
      this.rings.push({ group, currentAngle: 0, targetAngle: 0 });
    }
  }

  /** A shaft through the ring stack plus an end cap either side of it. */
  private buildArborAndCaps(config: RingConfig): void {
    const { count, radius, thickness, spacing, axis, radialSegments } = config;
    const span = (count - 1) * spacing + thickness;

    const arbor = this.track(
      new THREE.CylinderGeometry(radius * 0.18, radius * 0.18, span * 1.06, 24),
    );
    alignGeometryToAxis(arbor, axis);
    this.root.add(new THREE.Mesh(arbor, this.materials.get('arbor')));

    const cap = this.track(
      new THREE.CylinderGeometry(radius * 1.12, radius * 1.12, thickness * 0.5, radialSegments),
    );
    alignGeometryToAxis(cap, axis);

    const capMaterial = this.materials.get('housing');
    const capOffset = span / 2 + thickness * 0.3;
    for (const side of [-1, 1]) {
      const mesh = new THREE.Mesh(cap, capMaterial);
      mesh.position[axis] = capOffset * side;
      this.root.add(mesh);
    }
  }

  private buildGear(spec: GearSpec): void {
    const group = new THREE.Group();
    group.name = `gear:${spec.id}`;
    group.position.set(...spec.position);
    group.quaternion.setFromUnitVectors(
      new THREE.Vector3(0, 1, 0),
      new THREE.Vector3(...spec.axis).normalize(),
    );

    // Child group spins about its own local Y, which the parent has already
    // aligned with the gear's configured axis.
    const spinner = new THREE.Group();
    group.add(spinner);

    const material = this.materials.get(spec.slot);

    const body = this.track(
      new THREE.CylinderGeometry(spec.radius, spec.radius, spec.thickness, 48),
    );
    spinner.add(new THREE.Mesh(body, material));

    const toothDepth = spec.radius * 0.22;
    const toothWidth = ((Math.PI * 2 * spec.radius) / spec.teeth) * 0.5;
    const tooth = this.track(new THREE.BoxGeometry(toothWidth, spec.thickness * 0.95, toothDepth));

    const teeth = new THREE.InstancedMesh(tooth, material, spec.teeth);
    const matrix = new THREE.Matrix4();
    const position = new THREE.Vector3();
    const quaternion = new THREE.Quaternion();
    const scale = new THREE.Vector3(1, 1, 1);
    const up = new THREE.Vector3(0, 1, 0);

    for (let i = 0; i < spec.teeth; i += 1) {
      const theta = (i / spec.teeth) * TWO_PI;
      const ringRadius = spec.radius + toothDepth * 0.35;
      position.set(Math.cos(theta) * ringRadius, 0, Math.sin(theta) * ringRadius);
      quaternion.setFromAxisAngle(up, Math.PI / 2 - theta);
      teeth.setMatrixAt(i, matrix.compose(position, quaternion, scale));
    }
    teeth.instanceMatrix.needsUpdate = true;
    spinner.add(teeth);

    this.root.add(group);
    this.gears.push({ spinner, spec });
  }
}

/** Rotates a Y-aligned primitive so its length runs along `axis`. */
function alignGeometryToAxis(geometry: THREE.BufferGeometry, axis: Axis): void {
  if (axis === 'x') geometry.rotateZ(Math.PI / 2);
  else if (axis === 'z') geometry.rotateX(Math.PI / 2);
}

/** An axis at right angles to `axis`, used to park each ring's index mark. */
function perpendicularAxis(axis: Axis): Axis {
  return axis === 'y' ? 'z' : 'y';
}

/** Box dimensions with `along` on `axis` and `across` on the other two. */
function axisDims(axis: Axis, along: number, across: number): Vec3 {
  if (axis === 'x') return [along, across, across];
  if (axis === 'y') return [across, along, across];
  return [across, across, along];
}

/** Wraps an angle into [-PI, PI) so rings take the short way round. */
function shortestAngle(radians: number): number {
  return ((((radians + Math.PI) % TWO_PI) + TWO_PI) % TWO_PI) - Math.PI;
}
