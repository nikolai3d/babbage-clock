import * as THREE from 'three';
import { MaterialLibrary } from './materials.js';
import { sharedMaterialRegistry } from './materialRegistry.js';
import { SceneLighting } from './lighting.js';
import { createGearGeometry, defaultSpokeStyleFor } from './geometry/gear.js';
import { createHousingParts } from './geometry/housing.js';
import { createDetentLeverGeometry, createEscapementParts } from './geometry/escapement.js';
import {
  alignToAxis,
  createRingBodyGeometry,
  createRingNumeralsGeometry,
} from './geometry/ring.js';
import {
  readingAngleForAxis,
  ringAxisOffset,
  ringPlaneAxes,
  ringStackSpan,
} from '../geometry/ringLayout.js';
import { boxProjectUv } from './geometry/uv.js';
import { Mechanism, type MechanismEvent, type MechanismInput } from '../mechanism/index.js';
import type { MaterialRegistry } from './materialRegistry.js';
import type {
  Axis,
  GearSpec,
  MaterialBinding,
  MaterialSlot,
  RingConfig,
  SceneDefinition,
} from '../scene/types.js';

const TWO_PI = Math.PI * 2;
/** Extra rotation the train takes from each tick, in radians. */
const TICK_KICK_RADIANS = 0.09;
/** Escape wheel speed relative to the drive, in radians per drive-second. */
const ESCAPE_WHEEL_RATE = 1.7;
/** Peak balance deflection in radians. */
const BALANCE_AMPLITUDE = 0.95;

interface GearView {
  readonly spinner: THREE.Object3D;
  readonly spec: GearSpec;
}

/** The case's own frame: which way it faces and how big it had to be. */
interface CaseMetrics {
  /** Axis the case mouth faces along. */
  readonly caseAxis: Axis;
  /** The two axes spanning the case mouth. */
  readonly uAxis: Axis;
  readonly vAxis: Axis;
  /** Clear radius the case encloses. */
  readonly clearance: number;
  /** Half the interior depth. */
  readonly halfDepth: number;
  /** Where the movement sits along the case axis, behind the rings. */
  readonly movementDepth: number;
}

export interface ClockSceneViewOptions {
  /**
   * When false, rings snap straight to their digit and every continuously
   * moving part — gear train, balance, detents — is frozen, so the frame is a
   * pure function of the current digits. Defaults to true. Set from
   * `?nomotion`; see `app/testHooks.ts`.
   */
  readonly motion?: boolean;
  /**
   * Where PBR material folders are loaded and cached. Shared across scenes on
   * purpose: switching away and back must not re-download anything. Defaults to
   * the process-wide registry, which is what the headless unit tests use.
   */
  readonly materials?: MaterialRegistry;
}

/**
 * The renderable form of a `SceneDefinition`.
 *
 * Every dimension, count, colour and light comes from the definition — nothing
 * about "seven rings" or "copper" is hardcoded here. The geometry comes from
 * the generators in `./geometry/`, and the *motion* comes from `Mechanism`,
 * which is three.js-free and unit-tested on its own. This class is the join:
 * it turns a mechanism sample into transforms and owns the GPU resources.
 *
 * Owns every GPU resource it creates; `dispose()` releases all of them.
 */
export class ClockSceneView {
  readonly root = new THREE.Group();
  readonly definition: SceneDefinition;
  /** The state machine driving every moving part. Subscribe for tick events. */
  readonly mechanism: Mechanism;

  private readonly materials: MaterialLibrary;
  /**
   * The scene's own analytic lights. Public because `EnvironmentController`
   * dims them while a lighting mood owns the rig; see `render/lighting.ts`.
   */
  readonly lighting: SceneLighting;
  private readonly geometries: THREE.BufferGeometry[] = [];
  /**
   * Objects that hold GPU resources of their own beyond their geometry and
   * material — InstancedMesh owns its instance-matrix buffer, for example.
   */
  private readonly disposables: { dispose(): void }[] = [];
  private readonly caseMetrics: CaseMetrics;

  private readonly ringGroups: THREE.Group[] = [];
  private readonly gears: GearView[] = [];

  /** Detent levers, one instance per ring, drawn in a single call. */
  private detents: THREE.InstancedMesh | null = null;
  private readonly detentBases: { position: THREE.Vector3; quaternion: THREE.Quaternion }[] = [];
  private readonly detentAxis = new THREE.Vector3();
  /** True once the levers have been written to the buffer in their rest pose. */
  private detentsSeated = false;

  private balance: THREE.Object3D | null = null;
  private escapeWheel: THREE.Object3D | null = null;

  /** Scratch objects, so the frame loop allocates nothing. */
  private readonly scratchMatrix = new THREE.Matrix4();
  private readonly scratchQuaternion = new THREE.Quaternion();
  private readonly scratchLift = new THREE.Quaternion();
  private readonly unitScale = new THREE.Vector3(1, 1, 1);

  constructor(
    scene: THREE.Scene,
    definition: SceneDefinition,
    options: ClockSceneViewOptions = {},
  ) {
    this.definition = definition;
    this.root.name = `scene:${definition.id}`;

    this.materials = new MaterialLibrary(
      definition.materials,
      options.materials ?? sharedMaterialRegistry(),
    );
    this.lighting = new SceneLighting(scene, definition.lighting);
    this.caseMetrics = measureCase(definition);
    this.mechanism = new Mechanism({
      ringCount: definition.rings.count,
      ...(options.motion === undefined ? {} : { motion: options.motion }),
    });

    this.buildHousing();
    this.buildRings(definition.rings);
    this.buildArborAndCaps(definition.rings);
    this.buildDetents(definition.rings);
    definition.gears.forEach((gear, index) => this.buildGear(gear, index));
    this.buildEscapement();

    scene.add(this.root);
  }

  get ringCount(): number {
    return this.definition.rings.count;
  }

  /**
   * Rebinds material slots at runtime.
   *
   * Nothing in the scene graph is touched: meshes hold the same material
   * instances they were built with, and `MaterialLibrary` rewrites those in
   * place once the new textures are in hand. No reload, no rebuild, no flash
   * through an untextured frame.
   */
  setMaterials(bindings: Partial<Record<MaterialSlot, MaterialBinding>>): void {
    this.materials.apply(bindings);
  }

  /** Resolves once every slot has finished loading whatever it was last given. */
  materialsReady(): Promise<void> {
    return this.materials.ready();
  }

  /** The binding currently in force for a slot. Read by the test API. */
  bindingFor(slot: MaterialSlot): MaterialBinding {
    return this.materials.bindingFor(slot);
  }

  /**
   * The digits currently on the reading line, most significant first.
   *
   * This is the readout the e2e test hooks report; it comes from the mechanism
   * rather than from a copy held here, so it cannot drift from what is drawn.
   */
  get displayedDigits(): readonly number[] {
    return this.mechanism.digits;
  }

  /**
   * Hands the mechanism one frame of the clock. Returns the event it started,
   * or null — which is almost every frame.
   */
  setFrame(input: MechanismInput, nowMs: number): MechanismEvent | null {
    return this.mechanism.update(input, nowMs);
  }

  /**
   * Applies the mechanism's state at `nowMs` to the scene graph.
   *
   * Takes an instant rather than a delta on purpose: every transform below is a
   * function of the clock, so a tab that slept for an hour is correct on its
   * first frame back and nothing can drift out of step with real time.
   */
  update(nowMs: number): void {
    const sample = this.mechanism.sample(nowMs);
    const axis = this.definition.rings.axis;

    for (let i = 0; i < this.ringGroups.length; i += 1) {
      this.ringGroups[i]!.rotation[axis] = sample.ringAngles[i] ?? 0;
    }

    this.applyDetents(sample.detentAngles);

    // The train runs off drive-phase seconds, not accumulated deltas: it stays
    // in step with the clock and coasts to a stop when the mechanism winds down.
    const kick = sample.tickPulse * TICK_KICK_RADIANS;
    for (const { spinner, spec } of this.gears) {
      const direction = Math.sign(spec.angularVelocity) || 1;
      spinner.rotation.y = wrapAngle(
        spec.angularVelocity * sample.drivePhaseSeconds + direction * kick,
      );
    }

    if (this.balance) {
      this.balance.rotation.y = sample.escapement * BALANCE_AMPLITUDE;
    }
    if (this.escapeWheel) {
      this.escapeWheel.rotation.y = wrapAngle(
        -ESCAPE_WHEEL_RATE * sample.drivePhaseSeconds - kick * 3,
      );
    }
  }

  dispose(): void {
    this.root.removeFromParent();
    this.root.clear();

    for (const disposable of this.disposables) disposable.dispose();
    this.disposables.length = 0;

    for (const geometry of this.geometries) geometry.dispose();
    this.geometries.length = 0;

    this.ringGroups.length = 0;
    this.gears.length = 0;
    this.detentBases.length = 0;
    this.detents = null;
    this.balance = null;
    this.escapeWheel = null;

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
      this.ringGroups.push(group);
    }
  }

  /** A shaft through the ring stack plus a bearing boss either side of it. */
  private buildArborAndCaps(config: RingConfig): void {
    const { radius, thickness, axis, radialSegments } = config;
    const span = ringStackSpan(config);

    // Raw three.js primitives arrive with their own 0…1 parameterisation, which
    // would tile a material at a different rate on every one of them. Projected
    // into the shared surface units documented in `./geometry/uv.ts`.
    const arbor = this.track(
      boxProjectUv(new THREE.CylinderGeometry(radius * 0.2, radius * 0.2, span * 1.3, 24)),
    );
    alignToAxis(arbor, axis);
    this.root.add(new THREE.Mesh(arbor, this.materials.get('arbor')));

    const boss = this.track(
      boxProjectUv(
        new THREE.CylinderGeometry(radius * 0.34, radius * 0.28, thickness * 0.6, radialSegments),
      ),
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
   * One detent lever per ring, resting in a notch on the drum.
   *
   * They are the visible answer to "why do the minute and hour rings stay
   * still": a lever only lifts while its own ring is turning, so a plain
   * seconds tick rocks exactly one of them and a deep carry rocks several at
   * once. All of them are a single `InstancedMesh` — one draw call for the
   * whole set — whose per-instance matrices are rewritten each frame.
   */
  private buildDetents(config: RingConfig): void {
    const { count, axis, spacing, radius, thickness } = config;

    const length = radius * 0.34;
    const geometry = this.track(createDetentLeverGeometry(length, thickness * 0.5));

    // The lever sits a quarter turn off the reading line so it never covers the
    // digit being read.
    const [uAxis, vAxis] = ringPlaneAxes(axis);
    const restAxis = readingAngleForAxis(axis) === 0 ? vAxis : uAxis;

    const axisVector = unitVector(axis);
    const restVector = unitVector(restAxis);
    this.detentAxis.copy(axisVector);

    // Lever-local: thin along X, hanging along -Y. Map that frame onto the ring
    // axis and the rest direction.
    const basis = new THREE.Matrix4().makeBasis(
      axisVector,
      restVector,
      new THREE.Vector3().crossVectors(axisVector, restVector),
    );
    const baseQuaternion = new THREE.Quaternion().setFromRotationMatrix(basis);

    const mesh = new THREE.InstancedMesh(geometry, this.materials.get('arbor'), count);
    mesh.name = 'detents';
    mesh.frustumCulled = false;

    for (let i = 0; i < count; i += 1) {
      const position = new THREE.Vector3();
      position[axis] = ringAxisOffset(i, count, spacing);
      position.addScaledVector(restVector, radius + length * 0.92);
      this.detentBases.push({ position, quaternion: baseQuaternion.clone() });
    }

    this.disposables.push(mesh);
    this.root.add(mesh);
    this.detents = mesh;
    this.applyDetents(this.detentBases.map(() => 0));
  }

  /**
   * Rocks each lever about its pivot by the mechanism's lift angle.
   *
   * Skipped entirely while every lever is seated, which is the overwhelming
   * majority of frames: rewriting and re-uploading the instance matrices 60
   * times a second to say "nothing moved" is a buffer upload for nothing.
   */
  private applyDetents(lifts: readonly number[]): void {
    const mesh = this.detents;
    if (!mesh) return;

    const seated = lifts.every((lift) => lift === 0);
    if (seated && this.detentsSeated) return;
    this.detentsSeated = seated;

    for (let i = 0; i < this.detentBases.length; i += 1) {
      const base = this.detentBases[i]!;
      this.scratchLift.setFromAxisAngle(this.detentAxis, lifts[i] ?? 0);
      this.scratchQuaternion.multiplyQuaternions(this.scratchLift, base.quaternion);
      this.scratchMatrix.compose(base.position, this.scratchQuaternion, this.unitScale);
      mesh.setMatrixAt(i, this.scratchMatrix);
    }
    mesh.instanceMatrix.needsUpdate = true;
  }

  /**
   * The case: shell, bezel, screw studs, open lid and shackle.
   *
   * Sized to enclose everything the scene contains, so a scene with more or
   * larger rings gets a bigger case without anyone editing numbers here. The
   * `frame` and `bezel` slots are bound by every scene and this is what
   * consumes them.
   */
  private buildHousing(): void {
    const { caseAxis, clearance, halfDepth } = this.caseMetrics;

    const parts = createHousingParts({
      innerRadius: clearance,
      depth: halfDepth * 2,
      radialSegments: Math.max(24, this.definition.rings.radialSegments),
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
      boxProjectUv(
        new THREE.CylinderGeometry(
          spec.radius * 0.075,
          spec.radius * 0.075,
          spec.thickness * 2.4,
          12,
        ),
      ),
    );
    group.add(new THREE.Mesh(pin, this.materials.get('arbor')));

    this.root.add(group);
    this.gears.push({ spinner, spec });
  }

  /**
   * The balance, its escape wheel and the cock that holds them, tucked into the
   * quadrant of the case the gear train leaves free.
   *
   * Sized and placed from the case, not from scene data: every scene gets one,
   * and it is the element that keeps the movement alive between ticks.
   */
  private buildEscapement(): void {
    const { caseAxis, uAxis, vAxis, clearance, movementDepth } = this.caseMetrics;
    const rings = this.definition.rings;

    const balanceRadius = clearance * 0.21;
    const escapeRadius = clearance * 0.105;
    const thickness = Math.max(rings.thickness * 0.22, clearance * 0.03);

    const parts = createEscapementParts({ balanceRadius, escapeRadius, thickness });

    // Lower left as seen through the case mouth, where the train has room. Far
    // enough out that the balance clears the drums and can actually be seen
    // swinging — a movement nobody can see is not worth the draw calls.
    const centre = new THREE.Vector3();
    centre[uAxis] = -clearance * 0.56;
    centre[vAxis] = -(rings.radius + balanceRadius * 0.72);
    centre[caseAxis] = movementDepth;

    const axisVector = unitVector(caseAxis);
    const spinAlignment = new THREE.Quaternion().setFromUnitVectors(
      new THREE.Vector3(0, 1, 0),
      axisVector,
    );

    const group = new THREE.Group();
    group.name = 'escapement';
    this.root.add(group);

    for (const part of parts) {
      const geometry = this.track(part.geometry);
      const holder = new THREE.Group();
      holder.name = part.name;
      holder.position.copy(centre);
      holder.quaternion.copy(spinAlignment);

      if (part.name === 'escapement:escape-wheel') {
        // Alongside the balance, meshing with it in spirit if not in geometry.
        const offset = new THREE.Vector3();
        offset[uAxis] = balanceRadius + escapeRadius * 1.05;
        offset[vAxis] = balanceRadius * 0.62;
        holder.position.add(offset);
      }

      const mesh = new THREE.Mesh(geometry, this.materials.get(part.slot));
      if (!part.spins) {
        holder.add(mesh);
        group.add(holder);
        continue;
      }

      const spinner = new THREE.Group();
      spinner.name = `${part.name}:spinner`;
      spinner.add(mesh);
      holder.add(spinner);
      group.add(holder);

      if (part.name === 'escapement:balance') this.balance = spinner;
      else this.escapeWheel = spinner;
    }
  }
}

/**
 * Works out which way the case faces and how much room it has to enclose.
 *
 * Shared by the housing and the escapement so the two cannot disagree about
 * where the inside of the case is.
 */
function measureCase(definition: SceneDefinition): CaseMetrics {
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
  let halfDepth = rings.radius * 1.12;
  let deepest = 0;

  for (const gear of definition.gears) {
    const u = gear.position[axisIndex(uAxis)];
    const v = gear.position[axisIndex(vAxis)];
    clearance = Math.max(clearance, Math.hypot(u, v) + gear.radius * 1.12);
    // Half the face width, not the whole of it: the position is the gear's
    // mid-plane. Measuring from the far face made every case a third deeper
    // than it needed to be, which is what buried the train in shadow.
    const reach = Math.abs(gear.position[axisIndex(caseAxis)]) + gear.thickness / 2;
    halfDepth = Math.max(halfDepth, reach + rings.radius * 0.14);
    deepest = Math.max(deepest, Math.abs(gear.position[axisIndex(caseAxis)]));
  }

  // The movement plane: where the gears are, or just clear of the drums when a
  // scene declares none.
  const movementDepth = -(deepest > 0 ? deepest : rings.radius * 1.18);

  return { caseAxis, uAxis, vAxis, clearance, halfDepth, movementDepth };
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

function unitVector(axis: Axis): THREE.Vector3 {
  return new THREE.Vector3(axis === 'x' ? 1 : 0, axis === 'y' ? 1 : 0, axis === 'z' ? 1 : 0);
}

/**
 * Keeps a rotation inside one turn.
 *
 * Wrapped rather than accumulated: a tab left open for days would otherwise
 * grow the angle until float precision makes the rotation visibly jitter.
 */
function wrapAngle(radians: number): number {
  return radians % TWO_PI;
}
