import * as THREE from 'three';
import { MaterialLibrary } from './materials.js';
import { SceneLighting } from './lighting.js';
import { createGearGeometry, defaultSpokeStyleFor } from './geometry/gear.js';
import { createHousingParts } from './geometry/housing.js';
import {
  alignToAxis,
  createRingBodyGeometry,
  createRingNumeralsGeometry,
} from './geometry/ring.js';
import {
  DIGITS_PER_RING,
  ringAngleForDigit,
  ringAxisOffset,
  ringPlaneAxes,
  ringStackSpan,
} from '../geometry/ringLayout.js';
import type { Axis, GearSpec, RingConfig, SceneDefinition } from '../scene/types.js';

const TWO_PI = Math.PI * 2;
/** How fast a ring settles on its digit, in units of "fraction closed per second". */
const RING_SETTLE_RATE = 10;

interface RingView {
  readonly group: THREE.Group;
  currentAngle: number;
  targetAngle: number;
}

export interface ClockSceneViewOptions {
  /**
   * When false, rings snap straight to their digit and gears stop turning, so
   * the frame is a pure function of the current digits. Defaults to true.
   */
  readonly motion?: boolean;
}

/**
 * The renderable form of a `SceneDefinition`.
 *
 * Every dimension, count, colour and light comes from the definition — nothing
 * about "seven rings" or "copper" is hardcoded here. The geometry itself comes
 * from the generators in `./geometry/`, which are in turn driven by the same
 * data; this class only assembles and animates what they produce.
 *
 * Owns every GPU resource it creates; `dispose()` releases all of them.
 */
export class ClockSceneView {
  readonly root = new THREE.Group();
  readonly definition: SceneDefinition;

  private readonly materials: MaterialLibrary;
  private readonly lighting: SceneLighting;
  private readonly geometries: THREE.BufferGeometry[] = [];
  /**
   * Objects that hold GPU resources of their own beyond their geometry and
   * material — InstancedMesh owns its instance-matrix buffer, for example.
   */
  private readonly disposables: { dispose(): void }[] = [];
  private readonly rings: RingView[] = [];
  private readonly gears: { spinner: THREE.Object3D; spec: GearSpec }[] = [];

  private readonly motion: boolean;

  constructor(scene: THREE.Scene, definition: SceneDefinition, options: ClockSceneViewOptions = {}) {
    this.definition = definition;
    this.motion = options.motion ?? true;
    this.root.name = `scene:${definition.id}`;

    this.materials = new MaterialLibrary(definition.materials);
    this.lighting = new SceneLighting(scene, definition.lighting);

    this.buildHousing(definition);
    this.buildRings(definition.rings);
    this.buildArborAndCaps(definition.rings);
    definition.gears.forEach((gear, index) => this.buildGear(gear, index));

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
      ring.targetAngle = ringAngleForDigit(digit, DIGITS_PER_RING);
    }
  }

  /** Advances animation. `dt` is seconds since the previous frame. */
  update(dt: number): void {
    // Settling fully in one step is what removes the frame-rate dependence:
    // with motion off, the ring angle depends only on the digit, never on how
    // many frames have elapsed since it changed.
    const settle = this.motion ? Math.min(1, dt * RING_SETTLE_RATE) : 1;
    const axis = this.definition.rings.axis;

    for (const ring of this.rings) {
      const delta = shortestAngle(ring.targetAngle - ring.currentAngle);
      ring.currentAngle += delta * settle;
      ring.group.rotation[axis] = ring.currentAngle;
    }

    if (!this.motion) return;

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

    for (const disposable of this.disposables) disposable.dispose();
    this.disposables.length = 0;

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

  /**
   * The rings themselves.
   *
   * Both geometries are built once and shared by every ring in the stack —
   * seven meshes, two buffers. Only the group transforms differ, which is what
   * lets each ring rotate independently without duplicating vertex data.
   */
  private buildRings(config: RingConfig): void {
    const { count, axis, spacing } = config;

    const body = this.track(createRingBodyGeometry(config));
    const numerals = this.track(createRingNumeralsGeometry(config));

    const bodyMaterial = this.materials.get(config.slot);
    const numeralMaterial = this.materials.get(config.markSlot);

    for (let i = 0; i < count; i += 1) {
      const group = new THREE.Group();
      group.name = `ring:${i}`;
      group.position[axis] = ringAxisOffset(i, count, spacing);

      group.add(new THREE.Mesh(body, bodyMaterial));
      group.add(new THREE.Mesh(numerals, numeralMaterial));

      this.root.add(group);
      this.rings.push({ group, currentAngle: 0, targetAngle: 0 });
    }
  }

  /** A shaft through the ring stack plus a bearing boss either side of it. */
  private buildArborAndCaps(config: RingConfig): void {
    const { radius, thickness, axis, radialSegments } = config;
    const span = ringStackSpan(config);

    const arbor = this.track(
      new THREE.CylinderGeometry(radius * 0.2, radius * 0.2, span * 1.3, 24),
    );
    alignToAxis(arbor, axis);
    this.root.add(new THREE.Mesh(arbor, this.materials.get('arbor')));

    const boss = this.track(
      new THREE.CylinderGeometry(radius * 0.34, radius * 0.28, thickness * 0.6, radialSegments),
    );
    alignToAxis(boss, axis);

    const bossMaterial = this.materials.get('housing');
    const offset = span / 2 + thickness * 0.35;
    for (const side of [-1, 1]) {
      const mesh = new THREE.Mesh(boss, bossMaterial);
      mesh.position[axis] = offset * side;
      this.root.add(mesh);
    }
  }

  /**
   * The case: shell, bezel, screw studs, open lid and shackle.
   *
   * Sized to enclose everything the scene contains, so a scene with more or
   * larger rings gets a bigger case without anyone editing numbers here. The
   * `frame` and `bezel` slots are bound by every scene and this is what
   * consumes them.
   */
  private buildHousing(definition: SceneDefinition): void {
    const { rings } = definition;
    const span = ringStackSpan(rings);

    // Clearance is measured in the plane of the case mouth, which is the plane
    // perpendicular to the *case* axis — not the ring axis. For the usual
    // horizontal cryptex those are different planes, and using the wrong one
    // sizes the case so the gears poke through its wall.
    const caseAxis = caseAxisFor(rings.axis);
    const [uAxis, vAxis] = ringPlaneAxes(caseAxis);

    // The ring stack presents its corner to that plane: half the stack along
    // the ring axis, the drum radius across it.
    const stackAlong = rings.axis === caseAxis ? rings.radius : span / 2;
    const stackAcross = rings.radius;
    let clearance = Math.hypot(stackAlong, stackAcross) * 1.08;
    let halfDepth = rings.radius * 1.1;

    for (const gear of definition.gears) {
      const u = gear.position[axisIndex(uAxis)];
      const v = gear.position[axisIndex(vAxis)];
      clearance = Math.max(clearance, Math.hypot(u, v) + gear.radius * 1.12);
      const depthReach = Math.abs(gear.position[axisIndex(caseAxis)]) + gear.thickness;
      halfDepth = Math.max(halfDepth, depthReach * 1.1);
    }

    const parts = createHousingParts({
      innerRadius: clearance,
      depth: halfDepth * 2,
      radialSegments: Math.max(24, rings.radialSegments),
    });

    const group = new THREE.Group();
    group.name = 'housing';
    // The generator builds the case opening along +Z; turn it if this scene
    // needs the mouth on a different axis.
    if (caseAxis === 'y') group.rotation.x = -Math.PI / 2;

    for (const part of parts) {
      const geometry = this.track(part.geometry);
      const material = this.materials.get(part.slot);
      if (part.instances) {
        const instanced = new THREE.InstancedMesh(geometry, material, part.instances.length);
        part.instances.forEach((matrix, i) => instanced.setMatrixAt(i, matrix));
        instanced.instanceMatrix.needsUpdate = true;
        instanced.name = part.name;
        this.disposables.push(instanced);
        group.add(instanced);
        continue;
      }
      const mesh = new THREE.Mesh(geometry, material);
      mesh.name = part.name;
      group.add(mesh);
    }

    this.root.add(group);
  }

  private buildGear(spec: GearSpec, index: number): void {
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

    const wheel = this.track(
      createGearGeometry({
        teeth: spec.teeth,
        radius: spec.radius,
        thickness: spec.thickness,
        spokeStyle: defaultSpokeStyleFor(index, spec.teeth),
      }),
    );
    spinner.add(new THREE.Mesh(wheel, this.materials.get(spec.slot)));

    // The arbor pin sits on the static group, not the spinner: a real one does
    // not turn with the wheel.
    const pin = this.track(
      new THREE.CylinderGeometry(
        spec.radius * 0.075,
        spec.radius * 0.075,
        spec.thickness * 2.4,
        12,
      ),
    );
    group.add(new THREE.Mesh(pin, this.materials.get('arbor')));

    this.root.add(group);
    this.gears.push({ spinner, spec });
  }
}

/**
 * Which way the case faces: across the ring stack, so the rings are seen from
 * the side. Only a stack that already runs along Z pushes the mouth elsewhere.
 */
function caseAxisFor(ringAxis: Axis): Axis {
  return ringAxis === 'z' ? 'y' : 'z';
}

/** Index of an axis within a `Vec3` tuple. */
function axisIndex(axis: Axis): 0 | 1 | 2 {
  if (axis === 'x') return 0;
  if (axis === 'y') return 1;
  return 2;
}

/** Wraps an angle into [-PI, PI) so rings take the short way round. */
function shortestAngle(radians: number): number {
  return ((((radians + Math.PI) % TWO_PI) + TWO_PI) % TWO_PI) - Math.PI;
}
