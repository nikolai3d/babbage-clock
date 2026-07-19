/**
 * Render-quality tiers.
 *
 * Phones are not small laptops: they have a high device pixel ratio, a fill-rate
 * bound GPU and a thermal budget measured in minutes. This module decides how
 * hard the renderer is allowed to push, from a description of the device rather
 * than from a user-agent string — so a throttled laptop and a mid-range phone
 * land in the same place for the same reason.
 *
 * Everything here is pure and DOM-free apart from {@link readDeviceProfile},
 * which is the one function that reads the environment. That split is what makes
 * the heuristic unit-testable: the tests describe a device and assert the tier.
 *
 * The viewer always wins. `?quality=` and the settings drawer set a
 * {@link QualityPreference}; `auto` is the only value that consults the
 * heuristic at all.
 */

/** What the renderer is allowed to spend. */
export type QualityTier = 'high' | 'low';

/** The viewer's choice: an explicit tier, or `auto` to let the app decide. */
export type QualityPreference = 'auto' | QualityTier;

/**
 * Texture resolution the material pipeline should prefer.
 *
 * Extension point for the PBR materials bead: texture memory is the first thing
 * an iOS tab is killed for, so the low tier asks for the smaller variant of an
 * authored set. Nothing consumes this yet — `MaterialLibrary` carries it and the
 * bead that adds texture loading reads it there.
 */
export type TextureSizePreference = 'full' | 'half';

/** Everything the heuristic is allowed to look at. */
export interface DeviceProfile {
  readonly devicePixelRatio: number;
  /** CSS pixels. */
  readonly viewportWidth: number;
  readonly viewportHeight: number;
  /** `navigator.hardwareConcurrency`, or a conservative guess when absent. */
  readonly hardwareConcurrency: number;
  /** True for touch input — `(pointer: coarse)`. */
  readonly coarsePointer: boolean;
  /** `navigator.deviceMemory` in GB where the browser reports it. */
  readonly deviceMemoryGb: number | null;
}

/** The knobs a tier turns. Read by the renderer; never by the UI. */
export interface QualitySettings {
  readonly tier: QualityTier;
  /**
   * Ceiling on `renderer.setPixelRatio`. Fill rate scales with the square of
   * this, so it is the single biggest lever on a phone: a 3x display capped at
   * 1.5 instead of 2 draws 44% of the fragments.
   */
  readonly maxPixelRatio: number;
  /**
   * Whether the lighting mood may draw its HDR panorama as the background.
   *
   * This is the environment lever the low tier pulls. A blurred panorama
   * background is a full-screen textured pass sampling the prefiltered cube
   * every frame, on top of the same lookup every PBR fragment already pays for.
   * Turning it off falls back to the mood's own authored gradient — content the
   * preset already ships, so the scene stays lit exactly as before and only the
   * backdrop changes. The environment map itself is kept: dropping it would
   * change the look completely, because every shipped mood scales the scene's
   * own analytic lights to zero.
   */
  readonly panoramaBackground: boolean;
  /**
   * Frame ceiling, or null for "as fast as the display allows". 30 fps on the
   * low tier roughly halves GPU work on a device that could sustain 60, which
   * is the difference between a warm phone and a hot one.
   */
  readonly maxFps: number | null;
  readonly textureSize: TextureSizePreference;
  /**
   * Resolution, in texels per side, of the shadow map a lighting mood's
   * shadow-casting key light renders into.
   *
   * Only the moods with a real key light cast shadows at all (see
   * `render/ibl/rig.ts`), so this costs nothing elsewhere. Halving the side on
   * the low tier quarters the shadow pass's fill and memory, which is the same
   * shape of saving as the pixel-ratio cap — and a soft-edged shadow degrades
   * gracefully at half resolution, unlike the numerals.
   */
  readonly shadowMapSize: number;
}

/** Retina displays gain little above 2x and cost a lot of fill rate. */
export const HIGH_TIER_MAX_PIXEL_RATIO = 2;
/** Below 1.5 the numerals visibly alias on the drums, which defeats the point. */
export const LOW_TIER_MAX_PIXEL_RATIO = 1.5;
/** Halving the frame rate is the cheapest thermal win available. */
export const LOW_TIER_MAX_FPS = 30;
/** Crisp key-light shadows on the mechanism at desktop viewing distances. */
export const HIGH_TIER_SHADOW_MAP_SIZE = 2048;
/** A quarter of the fill and memory; soft shadows survive it, numerals would not. */
export const LOW_TIER_SHADOW_MAP_SIZE = 1024;

/** Four cores or fewer is a phone or a very old laptop. */
const LOW_CORE_COUNT = 4;
/** `navigator.deviceMemory` reports 4 or less on most mid-range phones. */
const LOW_MEMORY_GB = 4;
/**
 * A touch device whose shortest side is this or less is a phone held in the
 * hand, not a desktop with a touchscreen.
 */
const HANDHELD_SHORT_SIDE_CSS_PX = 500;
/**
 * Device pixels a mid-range GPU can shade comfortably at 60 fps for a scene of
 * this weight. A 3x phone at 430x932 asks for 3.6M, well past it.
 */
const COMFORTABLE_DEVICE_PIXELS = 2_600_000;
/** Above this many cores, a large framebuffer is not evidence of a weak device. */
const CAPABLE_CORE_COUNT = 8;

/**
 * Picks a tier for a device.
 *
 * Deliberately biased towards `low` on handhelds: the cost of being wrong in
 * that direction is a slightly softer image, and in the other direction it is a
 * hot phone dropping frames. Each rule is independent and any one of them is
 * enough — they are different ways of being the same kind of constrained.
 */
export function detectQualityTier(profile: DeviceProfile): QualityTier {
  const shortSide = Math.min(profile.viewportWidth, profile.viewportHeight);
  const devicePixels =
    profile.viewportWidth * profile.viewportHeight * profile.devicePixelRatio ** 2;

  // A handheld. Every phone lands here, which is the intent.
  if (profile.coarsePointer && shortSide <= HANDHELD_SHORT_SIDE_CSS_PX) return 'low';
  if (profile.hardwareConcurrency <= LOW_CORE_COUNT) return 'low';
  if (profile.deviceMemoryGb !== null && profile.deviceMemoryGb <= LOW_MEMORY_GB) return 'low';
  // A big framebuffer on a machine without the cores to feed it: tablets and
  // thin-and-light laptops with scaled displays.
  if (devicePixels > COMFORTABLE_DEVICE_PIXELS && profile.hardwareConcurrency < CAPABLE_CORE_COUNT)
    return 'low';

  return 'high';
}

/** The settings a tier implies. */
export function qualitySettings(tier: QualityTier): QualitySettings {
  return tier === 'low'
    ? {
        tier,
        maxPixelRatio: LOW_TIER_MAX_PIXEL_RATIO,
        panoramaBackground: false,
        maxFps: LOW_TIER_MAX_FPS,
        textureSize: 'half',
        shadowMapSize: LOW_TIER_SHADOW_MAP_SIZE,
      }
    : {
        tier,
        maxPixelRatio: HIGH_TIER_MAX_PIXEL_RATIO,
        panoramaBackground: true,
        maxFps: null,
        textureSize: 'full',
        shadowMapSize: HIGH_TIER_SHADOW_MAP_SIZE,
      };
}

/** Resolves a preference against a device: `auto` asks the heuristic. */
export function resolveQualityTier(
  preference: QualityPreference,
  profile: DeviceProfile,
): QualityTier {
  return preference === 'auto' ? detectQualityTier(profile) : preference;
}

/** Parses `?quality=`. Anything unrecognised means `auto`, never an error. */
export function parseQualityPreference(raw: string | null | undefined): QualityPreference {
  const value = raw?.trim().toLowerCase();
  return value === 'low' || value === 'high' ? value : 'auto';
}

/**
 * Reads the current device.
 *
 * The only environment-dependent function here, and the only one that cannot be
 * unit-tested — which is why it does nothing but gather values. Defaults are
 * chosen so a browser that reports nothing is treated as capable: guessing
 * `low` for an unknown desktop would be the more visible mistake.
 */
export function readDeviceProfile(): DeviceProfile {
  const memory = (navigator as Navigator & { deviceMemory?: number }).deviceMemory;
  return {
    devicePixelRatio: window.devicePixelRatio || 1,
    viewportWidth: window.innerWidth,
    viewportHeight: window.innerHeight,
    hardwareConcurrency: navigator.hardwareConcurrency || CAPABLE_CORE_COUNT,
    coarsePointer: window.matchMedia?.('(pointer: coarse)').matches ?? false,
    deviceMemoryGb: typeof memory === 'number' ? memory : null,
  };
}
