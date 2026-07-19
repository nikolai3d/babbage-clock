/**
 * Scene definition types.
 *
 * This module is deliberately free of three.js imports: a scene definition is
 * plain data that can be authored, validated and unit-tested without a WebGL
 * context. `src/render/*` is the only place that turns these descriptions into
 * actual GPU objects.
 */

import type { GearSpokeStyle } from '../geometry/gearProfile.js';
import type { RingSeparator } from '../geometry/ringLayout.js';

/** A 3D vector expressed as a plain tuple so scene data stays serialisable. */
export type Vec3 = readonly [x: number, y: number, z: number];

/** Axis identifiers used for ring layout and gear rotation. */
export type Axis = 'x' | 'y' | 'z';

/**
 * Named material slots used across every scene.
 *
 * A later bead binds Substance-authored PBR texture sets to these names. Keep
 * the list stable: scene definitions and authored material sets are matched by
 * these identifiers.
 */
export const MATERIAL_SLOTS = [
  'housing',
  'bezel',
  'ring',
  'numerals',
  'gearA',
  'gearB',
  'gearC',
  'gearD',
  'arbor',
  'frame',
] as const;

export type MaterialSlot = (typeof MATERIAL_SLOTS)[number];

/**
 * A simple, texture-free material. This is what the scaffold ships with; it is
 * a valid long-term binding for scenes that intentionally look untextured.
 */
export interface PlaceholderMaterialBinding {
  readonly kind: 'placeholder';
  /** Base colour as a hex literal, e.g. `0xb87333`. */
  readonly color: number;
  readonly metalness: number;
  readonly roughness: number;
  readonly emissive?: number;
  readonly emissiveIntensity?: number;
}

/** Texture channels a Substance-authored material set may supply. */
export type PbrMapKind =
  'map' | 'normalMap' | 'roughnessMap' | 'metalnessMap' | 'aoMap' | 'emissiveMap';

/**
 * Extension point for the Substance PBR materials bead.
 *
 * The renderer already accepts these bindings; until the texture-loading bead
 * lands it falls back to a neutral placeholder so a scene that declares PBR
 * bindings still renders instead of crashing.
 */
export interface PbrMaterialBinding {
  readonly kind: 'pbr';
  /** Identifier of the authored texture set, e.g. `copper-padlock/housing`. */
  readonly textureSet: string;
  /** Per-channel asset paths, relative to the texture root. */
  readonly maps?: Partial<Record<PbrMapKind, string>>;
  readonly tiling?: readonly [number, number];
  /** Multipliers applied on top of the authored maps. */
  readonly metalness?: number;
  readonly roughness?: number;
}

export type MaterialBinding = PlaceholderMaterialBinding | PbrMaterialBinding;

/** Every slot must be bound, so a scene can never reference a missing material. */
export type MaterialSlotMap = Readonly<Record<MaterialSlot, MaterialBinding>>;

/**
 * Coaxial digit rings, cryptex style: `count` rings laid out along `axis`,
 * each rotating about that same axis.
 */
export interface RingConfig {
  readonly count: number;
  readonly radius: number;
  /** Ring width measured along the layout axis. */
  readonly thickness: number;
  /** Centre-to-centre distance between adjacent rings along the layout axis. */
  readonly spacing: number;
  readonly axis: Axis;
  readonly radialSegments: number;
  /** Slot used for the ring bodies. */
  readonly slot: MaterialSlot;
  /** Slot used for the per-ring index mark. */
  readonly markSlot: MaterialSlot;
  /**
   * Static separators inserted into the physical ring stack — each a
   * non-rotating drum carrying a colon at a `HHH:MM:SS` group boundary. Omitted,
   * a scene has none and its stack is exactly `count` rings, unchanged. A
   * separator is not a digit ring: it reads no time component and does not shift
   * which physical ring the mechanism drives (see `ringStackSlots`). Uses the
   * same `slot`/`markSlot` materials as the digit rings, so it matches the
   * scene's wheel style.
   */
  readonly separators?: readonly RingSeparator[];
}

/** A gear wheel in the decorative train. */
export interface GearSpec {
  readonly id: string;
  readonly slot: MaterialSlot;
  readonly radius: number;
  readonly thickness: number;
  readonly teeth: number;
  readonly position: Vec3;
  readonly axis: Vec3;
  /** Radians per second; sign selects the direction. */
  readonly angularVelocity: number;
  /**
   * Wheel style. Omitted, the style derives deterministically from the gear's
   * index and tooth count — which is why every scene so far never set it. Set
   * it when a scene wants a particular wheel (the reference image's 5-spoke
   * painted wheels, say) rather than whatever the derivation deals out.
   */
  readonly spokeStyle?: GearSpokeStyle;
}

/**
 * Where the escapement sits, in scene coordinates.
 *
 * Every scene gets an escapement, and its parts are always *sized* from the
 * case. Omitted, placement derives from the case geometry too — tucked into
 * the quadrant the gear train leaves free — which is why no scene so far sets
 * it. Declare it when a scene's case or layout puts that derivation somewhere
 * wrong. The case is sized around the rings and gears only — it does not grow
 * to enclose a declared placement, so keep one inside the case yourself.
 */
export interface EscapementPlacement {
  /** Centre of the balance wheel; the cock that holds it follows. */
  readonly position?: Vec3;
  /** Escape wheel centre relative to `position`. */
  readonly escapeWheelOffset?: Vec3;
}

/** IBL presets contributed by the lighting bead. */
export type EnvironmentPresetId =
  'none' | 'day' | 'sunny-day' | 'night' | 'steampunk-workshop' | 'busy-street';

/** Extension point for the IBL bead. Ignored by the scaffold renderer beyond intensity. */
export interface EnvironmentSpec {
  readonly preset: EnvironmentPresetId;
  readonly intensity?: number;
  /** When true the environment map is also drawn as the scene background. */
  readonly showAsBackground?: boolean;
}

export interface DirectionalLightSpec {
  readonly color: number;
  readonly intensity: number;
  readonly position: Vec3;
}

export interface LightingConfig {
  readonly background: number;
  readonly ambient: { readonly color: number; readonly intensity: number };
  readonly directional: readonly DirectionalLightSpec[];
  readonly environment?: EnvironmentSpec;
  /** Tone-mapping exposure applied while this scene is active. */
  readonly exposure?: number;
}

/** Camera placement plus the OrbitControls framing limits for this scene. */
export interface CameraConfig {
  readonly fov: number;
  readonly position: Vec3;
  readonly target: Vec3;
  readonly near: number;
  readonly far: number;
  readonly minDistance: number;
  readonly maxDistance: number;
  /** Polar angle limits in radians, clamping how far the camera may tilt. */
  readonly minPolarAngle: number;
  readonly maxPolarAngle: number;
}

/**
 * What the rings read out.
 *
 * `countdown` packs the remaining time into the available rings; `clock` shows
 * wall-clock time and is the mode the 6-ring variant bead will use.
 */
export type ClockMode = 'countdown' | 'clock';

/** The complete description of a switchable scene. */
export interface SceneDefinition {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly mode: ClockMode;
  readonly rings: RingConfig;
  readonly gears: readonly GearSpec[];
  /** Escapement placement override; omitted, it derives from the case. */
  readonly escapement?: EscapementPlacement;
  readonly materials: MaterialSlotMap;
  readonly lighting: LightingConfig;
  readonly camera: CameraConfig;
}
