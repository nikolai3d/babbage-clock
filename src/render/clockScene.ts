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
  createSeparatorGlyphGeometry,
} from './geometry/ring.js';
import {
  readingAngleForAxis,
  ringAxisOffset,
  ringPlaneAxes,
  ringStackSlots,
  ringStackSpan,
} from '../geometry/ringLayout.js';
import { boxProjectUv } from './geometry/uv.js';
import { AssetLibrary, sharedAssetRegistry } from './assets/index.js';
import {
  Mechanism,
  type MechanismEvent,
  type MechanismInput,
  type MechanismSample,
} from '../mechanism/index.js';
import type { AssetRegistry, PartRole } from './assets/index.js';
import type { MaterialRegistry } from './materialRegistry.js';
import type { TextureSizePreference } from '../app/quality.js';
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

/**
 * A generator geometry standing in for an authored part that has not loaded yet.
 *
 * A scene with an `AssetSpec` still builds synchronously from the generators,
 * because the model loads asynchronously and the constructor cannot wait. When
 * the model lands, every mesh in `meshes` is repointed at the authored geometry
 * and `generated` is disposed. See {@link ClockSceneView.applyAssets}.
 */
interface AssetTarget {
  readonly role: PartRole;
  readonly meshes: THREE.Mesh[];
  readonly generated: THREE.BufferGeometry;
}

/**
 * What {@link ClockSceneView.rolePart} hands back: the geometry a mesh should
 * use now, and a `claim` to register that mesh for the swap when it took the
 * generator fallback (a no-op when it took an authored part).
 */
interface RolePart {
  readonly geometry: THREE.BufferGeometry;
  readonly claim: (mesh: THREE.Mesh) => void;
}

const noop = (): void => undefined;

/** Housing generator part name -> authored role. */
const HOUSING_ROLES: Record<string, PartRole> = {
  'housing:case': 'case-shell',
  'housing:bezel': 'bezel',
  'housing:studs': 'stud',
  'housing:lid': 'lid',
  'housing:hinge': 'hinge',
  'housing:shackle': 'shackle',
};

/** Escapement generator part name -> authored role. */
const ESCAPEMENT_ROLES: Record<
  'escapement:balance' | 'escapement:escape-wheel' | 'escapement:cock',
  PartRole
> = {
  'escapement:balance': 'balance',
  'escapement:escape-wheel': 'escape-wheel',
  'escapement:cock': 'balance-cock',
};

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
  /**
   * Texture resolution the material pipeline should prefer, from the active
   * quality tier. Threaded through to `MaterialLibrary`; see `app/quality.ts`.
   * Defaults to `full`.
   */
  readonly textureSize?: TextureSizePreference;
  /**
   * Where authored glTF models are loaded and cached. Shared across scenes on
   * purpose, exactly like {@link ClockSceneViewOptions.materials}: switching
   * away and back must not re-download anything. Defaults to the process-wide
   * registry, which the headless unit tests use.
   */
  readonly assets?: AssetRegistry;
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

  /** Authored geometry for this scene, or an empty handle when it is procedural. */
  private readonly assets: AssetLibrary;
  /** Generator geometries standing in for authored parts that have not loaded. */
  private readonly assetTargets: AssetTarget[] = [];
  /** Resolves once authored parts (if any) have been swapped in. */
  private assetsSettled: Promise<void> = Promise.resolve();
  private assetsApplied = false;
  private disposed = false;

  private readonly ringGroups: THREE.Group[] = [];
  private readonly gears: GearView[] = [];

  /**
   * The ring rotations most recently written to the scene graph, in radians.
   *
   * Kept for the `?testApi` observation surface: a travel (a seek that spins
   * the drums to a new reading) exists only in these angles — the logical
   * digits update the instant the target changes — so an e2e spec asserting
   * "the rings travelled rather than teleporting" needs the per-frame angle,
   * not a screenshot. See `app/testHooks.ts`.
   */
  private lastAppliedRingAngles: readonly number[] = [];

  /** Detent levers, one instance per ring, drawn in a single call. */
  private detents: THREE.InstancedMesh | null = null;
  private readonly detentBases: { position: THREE.Vector3; quaternion: THREE.Quaternion }[] = [];
  private readonly detentAxis = new THREE.Vector3();
  /** True once the levers have been written to the buffer in their rest pose. */
  private detentsSeated = false;

  private balance: THREE.Object3D | null = null;
  private escapeWheel: THREE.Object3D | null = null;

  /**
   * The sample whose transforms the graph currently shows. `update` compares
   * against it so a frame where the mechanism did not move — a frozen test
   * clock, a wound-down countdown — reports that nothing changed and the
   * renderer can hold the frame it already drew. See `ClockRenderer.frame`.
   */
  private appliedSample: MechanismSample | null = null;

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

    this.materials = new MaterialLibrary(definition.materials, {
      registry: options.materials ?? sharedMaterialRegistry(),
      textureSize: options.textureSize ?? 'full',
    });
    this.assets = new AssetLibrary(definition.assets, {
      registry: options.assets ?? sharedAssetRegistry(),
    });
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

    // A scene that declares authored geometry has built from the generators
    // above, because the model loads asynchronously and the constructor cannot
    // wait. Swap the authored parts in once the model is in hand; a failed load
    // resolves too, leaving the generators in place.
    if (this.assets.hasSpec) {
      this.assetsSettled = this.assets.ready().then(() => this.applyAssets());
    }

    // Everything both casts and receives: the shadows worth having here are
    // the mechanism shadowing *itself* — rings onto the case interior, the lid
    // and shackle onto the shell, numerals onto their own drum — and any split
    // (say, the case receiving but not casting) invents a physically impossible
    // frame that reads as a lighting bug. Whether any shadow is drawn at all is
    // the lighting mood's decision: only a mood whose key light carries a
    // `shadow` block casts (see `render/ibl/rig.ts`), so scenes under every
    // other mood pay nothing for these flags.
    this.root.traverse((object) => {
      if ((object as THREE.Mesh).isMesh) {
        object.castShadow = true;
        object.receiveShadow = true;
      }
    });

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

  /**
   * True while any material slot is still loading. Polled by the render loop:
   * an async texture commit changes what a frame looks like without moving the
   * mechanism, so a held frame must be redrawn when one lands.
   */
  get materialsBusy(): boolean {
    return this.materials.busy;
  }

  /**
   * True while authored geometry is still loading or has not yet been swapped
   * in. Polled by the render loop the same way {@link materialsBusy} is: the
   * swap changes the picture without the mechanism moving, so a held frame must
   * be redrawn when it lands.
   */
  get assetsBusy(): boolean {
    return this.assets.busy || (this.assets.hasSpec && !this.assetsApplied);
  }

  /** Resolves once authored parts (if any) have been swapped in. */
  assetsReady(): Promise<void> {
    return this.assetsSettled;
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

  /** The ring rotations last applied by {@link update}, in radians. */
  get appliedRingAngles(): readonly number[] {
    return this.lastAppliedRingAngles;
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
   *
   * Returns whether anything moved. A live clock moves every frame (the drive
   * phase is continuous), but under a frozen test clock the sample reaches a
   * fixed point — and reporting that lets the renderer stop redrawing an
   * unchanged frame, which is what makes a deterministic capture bit-stable
   * however slow or contended the machine taking it is.
   */
  update(nowMs: number): boolean {
    const sample = this.mechanism.sample(nowMs);
    if (this.appliedSample !== null && sampleEquals(this.appliedSample, sample)) {
      return false;
    }
    this.appliedSample = sample;
    const axis = this.definition.rings.axis;

    for (let i = 0; i < this.ringGroups.length; i += 1) {
      this.ringGroups[i]!.rotation[axis] = sample.ringAngles[i] ?? 0;
    }
    this.lastAppliedRingAngles = sample.ringAngles;

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
    return true;
  }

  dispose(): void {
    this.disposed = true;
    this.root.removeFromParent();
    this.root.clear();

    for (const disposable of this.disposables) disposable.dispose();
    this.disposables.length = 0;

    // Only generator geometries are tracked; authored parts are borrowed from
    // the registry and released by `this.assets.dispose()` below.
    for (const geometry of this.geometries) geometry.dispose();
    this.geometries.length = 0;
    this.assetTargets.length = 0;

    this.ringGroups.length = 0;
    this.gears.length = 0;
    this.detentBases.length = 0;
    this.detents = null;
    this.balance = null;
    this.escapeWheel = null;

    this.lighting.dispose();
    this.materials.dispose();
    this.assets.dispose();
  }

  private track<T extends THREE.BufferGeometry>(geometry: T): T {
    this.geometries.push(geometry);
    return geometry;
  }

  /**
   * The geometry a role should use: the authored part when the model provides
   * one, otherwise a freshly generated fallback.
   *
   * The fallback factory is only invoked when there is no authored part, so an
   * authored scene never pays to build geometry it will not show. When the
   * fallback is used and the scene declares a model, each mesh that takes it is
   * registered (via `claim`) for an in-place swap once the model loads.
   */
  private rolePart(role: PartRole, build: () => THREE.BufferGeometry): RolePart {
    const authored = this.assets.part(role);
    if (authored) return { geometry: authored, claim: noop };
    return this.fallbackPart(role, this.track(build()));
  }

  /**
   * As {@link rolePart}, for parts whose generator geometry is already built —
   * the housing and escapement generators produce every piece eagerly. The
   * unused eager geometry is disposed straight away when an authored part wins,
   * so nothing leaks.
   */
  private rolePartEager(role: PartRole, generated: THREE.BufferGeometry): RolePart {
    const authored = this.assets.part(role);
    if (authored) {
      generated.dispose();
      return { geometry: authored, claim: noop };
    }
    return this.fallbackPart(role, this.track(generated));
  }

  private fallbackPart(role: PartRole, generated: THREE.BufferGeometry): RolePart {
    if (!this.assets.hasSpec) return { geometry: generated, claim: noop };
    const target: AssetTarget = { role, meshes: [], generated };
    this.assetTargets.push(target);
    return { geometry: generated, claim: (mesh: THREE.Mesh) => target.meshes.push(mesh) };
  }

  /**
   * Repoints every waiting mesh at its authored geometry and disposes the
   * generator it replaced.
   *
   * Runs once, after the model resolves. Authored geometry is *borrowed* from
   * the registry — never tracked here, never disposed here — so the replaced
   * generator is pulled out of {@link geometries} before {@link dispose} would
   * double it up. A role the model turns out not to carry keeps its generator.
   */
  private applyAssets(): void {
    if (this.disposed) return;
    for (const target of this.assetTargets) {
      const authored = this.assets.part(target.role);
      if (!authored) continue;
      for (const mesh of target.meshes) mesh.geometry = authored;
      const index = this.geometries.indexOf(target.generated);
      if (index >= 0) this.geometries.splice(index, 1);
      target.generated.dispose();
    }
    this.assetTargets.length = 0;
    this.assetsApplied = true;
  }

  /**
   * The rings themselves, plus any static separators.
   *
   * The digit drum, its numerals and the colon a separator carries are each one
   * shared buffer across the whole stack — only the group transforms differ,
   * which is what lets each digit ring rotate independently without duplicating
   * vertex data. The physical order comes from `ringStackSlots`: separators take
   * their own positions between the digit rings, so a scene reads `HHH:MM:SS`
   * with colons at the group boundaries. Crucially, a digit ring keeps its
   * `digitIndex` however many separators precede it, so `ringGroups[i]` is still
   * the mechanism's ring `i` — inserting a separator shifts nothing the clock
   * drives, only where the drum sits.
   */
  private buildRings(config: RingConfig): void {
    const { count, axis, spacing } = config;
    const slots = ringStackSlots(count, config.separators ?? []);
    const physical = slots.length;

    const body = this.rolePart('ring-body', () => createRingBodyGeometry(config));
    const numerals = this.rolePart('numerals', () => createRingNumeralsGeometry(config));

    const bodyMaterial = this.materials.get(config.slot);
    const numeralMaterial = this.materials.get(config.markSlot);

    // Built lazily and shared: no separator, no colon geometry at all. Every
    // separator carries the same colon, so one buffer serves them all.
    let separatorGlyph: THREE.BufferGeometry | null = null;

    slots.forEach((slot, slotIndex) => {
      const group = new THREE.Group();
      group.position[axis] = ringAxisOffset(slotIndex, physical, spacing);
      const bodyMesh = new THREE.Mesh(body.geometry, bodyMaterial);
      body.claim(bodyMesh);
      group.add(bodyMesh);

      if (slot.kind === 'digit') {
        group.name = `ring:${slot.digitIndex}`;
        const numeralMesh = new THREE.Mesh(numerals.geometry, numeralMaterial);
        numerals.claim(numeralMesh);
        group.add(numeralMesh);
        this.root.add(group);
        // Digit slots arrive in ascending `digitIndex`, so pushing keeps
        // `ringGroups[i]` aligned with the mechanism's ring `i`; `update` maps
        // them one-to-one. Separators are never pushed — they are never sampled.
        this.ringGroups.push(group);
      } else {
        group.name = `separator:${slotIndex}`;
        if (!separatorGlyph) {
          separatorGlyph = this.track(createSeparatorGlyphGeometry(config, slot.glyph));
        }
        group.add(new THREE.Mesh(separatorGlyph, numeralMaterial));
        this.root.add(group);
      }
    });
  }

  /** A shaft through the ring stack plus a bearing boss either side of it. */
  private buildArborAndCaps(config: RingConfig): void {
    const { radius, thickness, axis, radialSegments } = config;
    const span = ringStackSpan(config);

    // Raw three.js primitives arrive with their own 0…1 parameterisation, which
    // would tile a material at a different rate on every one of them. Projected
    // into the shared surface units documented in `./geometry/uv.ts`.
    const arbor = this.rolePart('arbor', () => {
      const geometry = boxProjectUv(
        new THREE.CylinderGeometry(radius * 0.2, radius * 0.2, span * 1.3, 24),
      );
      alignToAxis(geometry, axis);
      return geometry;
    });
    const arborMesh = new THREE.Mesh(arbor.geometry, this.materials.get('arbor'));
    arbor.claim(arborMesh);
    this.root.add(arborMesh);

    const boss = this.rolePart('boss', () => {
      const geometry = boxProjectUv(
        new THREE.CylinderGeometry(radius * 0.34, radius * 0.28, thickness * 0.6, radialSegments),
      );
      alignToAxis(geometry, axis);
      return geometry;
    });

    const bossMaterial = this.materials.get('housing');
    const offset = span / 2 + thickness * 0.35;
    for (const side of [-1, 1]) {
      const mesh = new THREE.Mesh(boss.geometry, bossMaterial);
      mesh.position[axis] = offset * side;
      boss.claim(mesh);
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
    const slots = ringStackSlots(count, config.separators ?? []);
    const physical = slots.length;

    const length = radius * 0.34;
    const lever = this.rolePart('detent-lever', () =>
      createDetentLeverGeometry(length, thickness * 0.5),
    );

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

    const mesh = new THREE.InstancedMesh(lever.geometry, this.materials.get('arbor'), count);
    mesh.name = 'detents';
    mesh.frustumCulled = false;
    lever.claim(mesh);

    // One lever per digit ring, seated at that ring's physical position — a
    // separator does not turn, so it gets no detent. Physical positions come
    // from the same slot layout `buildRings` uses, so lever and drum stay
    // aligned however many separators sit between them.
    for (const [slotIndex, slot] of slots.entries()) {
      if (slot.kind !== 'digit') continue;
      const position = new THREE.Vector3();
      position[axis] = ringAxisOffset(slotIndex, physical, spacing);
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
      const role = HOUSING_ROLES[part.name];
      const rolePart = role
        ? this.rolePartEager(role, part.geometry)
        : { geometry: this.track(part.geometry), claim: noop };
      const material = this.materials.get(part.slot);
      if (part.instances) {
        const instanced = new THREE.InstancedMesh(
          rolePart.geometry,
          material,
          part.instances.length,
        );
        part.instances.forEach((matrix, i) => instanced.setMatrixAt(i, matrix));
        instanced.instanceMatrix.needsUpdate = true;
        instanced.name = part.name;
        rolePart.claim(instanced);
        this.disposables.push(instanced);
        group.add(instanced);
        continue;
      }
      const mesh = new THREE.Mesh(rolePart.geometry, material);
      mesh.name = part.name;
      rolePart.claim(mesh);
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

    const wheel = this.rolePart(spec.slot as PartRole, () =>
      createGearGeometry({
        teeth: spec.teeth,
        radius: spec.radius,
        thickness: spec.thickness,
        spokeStyle: spec.spokeStyle ?? defaultSpokeStyleFor(index, spec.teeth),
      }),
    );
    const wheelMesh = new THREE.Mesh(wheel.geometry, this.materials.get(spec.slot));
    wheel.claim(wheelMesh);
    spinner.add(wheelMesh);

    // The arbor pin sits on the static group, not the spinner: a real one does
    // not turn with the wheel.
    const pin = this.rolePart('gear-pin', () =>
      boxProjectUv(
        new THREE.CylinderGeometry(
          spec.radius * 0.075,
          spec.radius * 0.075,
          spec.thickness * 2.4,
          12,
        ),
      ),
    );
    const pinMesh = new THREE.Mesh(pin.geometry, this.materials.get('arbor'));
    pin.claim(pinMesh);
    group.add(pinMesh);

    this.root.add(group);
    this.gears.push({ spinner, spec });
  }

  /**
   * The balance, its escape wheel and the cock that holds them.
   *
   * Every scene gets one — it is the element that keeps the movement alive
   * between ticks — and it is always *sized* from the case. Placement derives
   * from the case too unless the scene declares `escapement`, for a case or
   * layout where the derived quadrant is the wrong place.
   */
  private buildEscapement(): void {
    const { caseAxis, uAxis, vAxis, clearance, movementDepth } = this.caseMetrics;
    const rings = this.definition.rings;
    const placement = this.definition.escapement;

    const balanceRadius = clearance * 0.21;
    const escapeRadius = clearance * 0.105;
    const thickness = Math.max(rings.thickness * 0.22, clearance * 0.03);

    const parts = createEscapementParts({ balanceRadius, escapeRadius, thickness });

    // Default: lower left as seen through the case mouth, where the train has
    // room. Far enough out that the balance clears the drums and can actually
    // be seen swinging — a movement nobody can see is not worth the draw calls.
    const centre = new THREE.Vector3();
    if (placement?.position) {
      centre.set(...placement.position);
    } else {
      centre[uAxis] = -clearance * 0.56;
      centre[vAxis] = -(rings.radius + balanceRadius * 0.72);
      centre[caseAxis] = movementDepth;
    }

    const axisVector = unitVector(caseAxis);
    const spinAlignment = new THREE.Quaternion().setFromUnitVectors(
      new THREE.Vector3(0, 1, 0),
      axisVector,
    );

    const group = new THREE.Group();
    group.name = 'escapement';
    this.root.add(group);

    for (const part of parts) {
      const rolePart = this.rolePartEager(ESCAPEMENT_ROLES[part.name], part.geometry);
      const holder = new THREE.Group();
      holder.name = part.name;
      holder.position.copy(centre);
      holder.quaternion.copy(spinAlignment);

      if (part.name === 'escapement:escape-wheel') {
        // Alongside the balance, meshing with it in spirit if not in geometry.
        const offset = new THREE.Vector3();
        if (placement?.escapeWheelOffset) {
          offset.set(...placement.escapeWheelOffset);
        } else {
          offset[uAxis] = balanceRadius + escapeRadius * 1.05;
          offset[vAxis] = balanceRadius * 0.62;
        }
        holder.position.add(offset);
      }

      const mesh = new THREE.Mesh(rolePart.geometry, this.materials.get(part.slot));
      rolePart.claim(mesh);
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

/**
 * How each field of a `MechanismSample` is compared.
 *
 * The mapped `satisfies` is the point, and it checks both directions: adding a
 * field to the sample without classifying it here fails to compile, and so
 * does classifying one wrongly. Both matter. An uncompared field would leave
 * the held frame refusing to redraw when only that field moved; a scalar
 * mislabelled `'array'` would be worse, because `numbersEqual` would read
 * `.length` as undefined on both numbers, pass its own length guard, never
 * enter the loop, and report every pair equal — freezing the frame for good.
 */
const SAMPLE_FIELDS = {
  drivePhaseSeconds: 'scalar',
  driveFactor: 'scalar',
  escapement: 'scalar',
  tickPulse: 'scalar',
  running: 'scalar',
  expired: 'scalar',
  ringAngles: 'array',
  detentAngles: 'array',
  digits: 'array',
} as const satisfies {
  [K in keyof MechanismSample]: MechanismSample[K] extends readonly number[] ? 'array' : 'scalar';
};

/**
 * The same table, split once at module load.
 *
 * `sampleEquals` runs every frame, so the entries are built once here rather
 * than per call. The `for…of` below still walks an iterator over these nine
 * fixed elements; that is a deliberate line to draw, since the allocation this
 * file actually cares about is the per-frame garbage the scratch objects above
 * exist to avoid, not a loop V8 escape-analyses away.
 */
const SAMPLE_ENTRIES: ReadonlyArray<readonly [keyof MechanismSample, 'scalar' | 'array']> =
  Object.entries(SAMPLE_FIELDS) as ReadonlyArray<
    readonly [keyof MechanismSample, 'scalar' | 'array']
  >;

/**
 * Whether two samples would put the scene graph in the same pose.
 *
 * Exact equality on purpose: the mechanism is a pure function of the instant,
 * so a frozen clock reproduces bit-identical samples, and anything short of
 * bit-identical must be drawn. Every field is compared — including ones
 * `update` does not read today — so a future use of, say, `driveFactor` cannot
 * silently break the held-frame optimisation.
 */
function sampleEquals(a: MechanismSample, b: MechanismSample): boolean {
  for (const [key, kind] of SAMPLE_ENTRIES) {
    if (kind === 'array') {
      if (!numbersEqual(a[key] as readonly number[], b[key] as readonly number[])) return false;
    } else if (a[key] !== b[key]) {
      return false;
    }
  }
  return true;
}

function numbersEqual(a: readonly number[], b: readonly number[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}
