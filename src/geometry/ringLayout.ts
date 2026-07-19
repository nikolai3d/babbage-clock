/**
 * Digit-ring layout maths — pure, three.js-free, and the thing the ring
 * generator is a function of.
 *
 * A digit ring is a cryptex drum: `digitsPerRing` numerals engraved evenly
 * around the circumference, scrolling past a fixed reading line as the drum
 * turns. Nothing here knows how many rings a scene has; that is `RingConfig`
 * data, which is what lets a later bead add a six-ring clock variant purely by
 * editing a scene file.
 */

import { GLYPH_EM_HEIGHT, GLYPH_EM_WIDTH } from './digitGlyphs.js';
import type { Axis, RingConfig } from '../scene/types.js';

export const DIGITS_PER_RING = 10;

const TWO_PI = Math.PI * 2;

/**
 * The glyph a static separator ring carries. Only a colon exists today — the
 * mark between the `HHH:MM:SS` groups — but the field is named so a later mark
 * (a decimal point, a slash) is a data change rather than a new boolean.
 */
export type SeparatorGlyph = 'colon';

/**
 * A static separator in the physical ring stack.
 *
 * It is a drum like the digit rings — same materials and style — but it carries
 * a fixed glyph, does not rotate, and reads no time component. It marks a group
 * boundary in the `HHH:MM:SS` readout, so a scene lists its separators alongside
 * the digit-ring count rather than hardcoding them in the renderer.
 */
export interface RingSeparator {
  /**
   * How many digit rings precede this separator, in `[0, count]`. The colon at
   * the hours|minutes boundary of a seven-ring `HHH:MM:SS` readout is
   * `afterRing: 3`; the one at minutes|seconds is `afterRing: 5`.
   */
  readonly afterRing: number;
  /** The glyph the separator carries. Defaults to a colon. */
  readonly glyph?: SeparatorGlyph;
}

/**
 * One physical position in the ring stack: a rotating digit ring driven by the
 * mechanism, or a static separator.
 */
export type RingStackSlot =
  | { readonly kind: 'digit'; readonly digitIndex: number }
  | { readonly kind: 'separator'; readonly glyph: SeparatorGlyph };

/** Angle between adjacent digits: 36 degrees for the usual ten. */
export function digitStepAngle(digitsPerRing: number = DIGITS_PER_RING): number {
  if (!Number.isInteger(digitsPerRing) || digitsPerRing < 1) {
    throw new Error(`digitsPerRing must be a positive integer, got ${digitsPerRing}`);
  }
  return TWO_PI / digitsPerRing;
}

/**
 * The two axes perpendicular to the ring axis, ordered so that a positive
 * rotation about the ring axis carries `u` towards `v`.
 *
 * This is the right-hand rule spelled out, and it is what keeps the digit
 * placement and the ring rotation in `ClockSceneView` agreeing with each other.
 */
export function ringPlaneAxes(axis: Axis): readonly [Axis, Axis] {
  switch (axis) {
    case 'x':
      return ['y', 'z'];
    case 'y':
      return ['z', 'x'];
    case 'z':
      return ['x', 'y'];
  }
}

/**
 * Where the reading line sits, as an angle in the ring plane.
 *
 * The camera looks down -Z, so for the horizontal cryptex layout (`axis: 'x'`)
 * the digit being read is the one facing +Z.
 */
export function readingAngleForAxis(axis: Axis): number {
  switch (axis) {
    case 'x':
      return Math.PI / 2; // +Z, i.e. the v axis
    case 'y':
      return 0; // +Z, i.e. the u axis
    case 'z':
      return Math.PI / 2; // +Y: a face-on ring reads at the top
  }
}

/**
 * The angle at which `digit` is engraved.
 *
 * `ClockSceneView` rotates a ring by `-digit * step`, so engraving digit d at
 * `readingAngle + d * step` brings exactly that digit to the reading line. The
 * two must stay in step; that relationship is what the unit tests pin down.
 */
export function digitAngle(
  digit: number,
  digitsPerRing: number = DIGITS_PER_RING,
  readingAngle = 0,
): number {
  return readingAngle + digit * digitStepAngle(digitsPerRing);
}

/** Rotation that brings `digit` to the reading line. */
export function ringAngleForDigit(digit: number, digitsPerRing: number = DIGITS_PER_RING): number {
  return -digit * digitStepAngle(digitsPerRing);
}

/** Position of ring `index` along the layout axis, with the stack centred on 0. */
export function ringAxisOffset(index: number, count: number, spacing: number): number {
  return (index - (count - 1) / 2) * spacing;
}

/**
 * The physical order of the ring stack: `count` digit rings interleaved with any
 * static separators, in reading order.
 *
 * A slot at index `k` sits at `ringAxisOffset(k, slots.length, spacing)`. A
 * digit slot carries the `digitIndex` of the mechanism ring that drives it —
 * always its position among the digit rings, never among the physical slots —
 * so inserting a separator never shifts which time component a ring reads. That
 * decoupling is the whole point: the mechanism still sees exactly `count` rings.
 */
export function ringStackSlots(
  count: number,
  separators: readonly RingSeparator[] = [],
): RingStackSlot[] {
  const sorted = [...separators].sort((a, b) => a.afterRing - b.afterRing);
  const slots: RingStackSlot[] = [];
  let next = 0;
  const flushSeparatorsAt = (boundary: number): void => {
    while (next < sorted.length && sorted[next]!.afterRing === boundary) {
      slots.push({ kind: 'separator', glyph: sorted[next]!.glyph ?? 'colon' });
      next += 1;
    }
  };
  for (let digit = 0; digit < count; digit += 1) {
    flushSeparatorsAt(digit);
    slots.push({ kind: 'digit', digitIndex: digit });
  }
  flushSeparatorsAt(count);
  // Any separator whose `afterRing` fell outside `[0, count]` is invalid data —
  // `scene/validate.ts` rejects it — but emit it anyway so the physical slot
  // count can never silently disagree with the number of separators declared.
  for (; next < sorted.length; next += 1) {
    slots.push({ kind: 'separator', glyph: sorted[next]!.glyph ?? 'colon' });
  }
  return slots;
}

/** How many physical positions the stack occupies, separators included. */
export function physicalRingCount(config: Pick<RingConfig, 'count' | 'separators'>): number {
  return config.count + (config.separators?.length ?? 0);
}

/** Total extent of the ring stack along the layout axis, including ring width. */
export function ringStackSpan(
  config: Pick<RingConfig, 'count' | 'spacing' | 'thickness' | 'separators'>,
): number {
  return (physicalRingCount(config) - 1) * config.spacing + config.thickness;
}

export interface NumeralLayout {
  /** Glyph cap height in metres. */
  readonly glyphHeight: number;
  /** Glyph advance width in metres, measured along the ring axis. */
  readonly glyphWidth: number;
  /** Arc length available to each digit around the circumference. */
  readonly arcPerDigit: number;
  /** Angle between adjacent digits. */
  readonly stepAngle: number;
}

export interface NumeralLayoutOptions {
  readonly digitsPerRing?: number;
  /** Glyph height as a fraction of the arc length available per digit. */
  readonly heightFraction?: number;
  /** Hard cap on glyph height as a fraction of the ring's width. */
  readonly widthFraction?: number;
}

export const DEFAULT_NUMERAL_HEIGHT_FRACTION = 0.62;
export const DEFAULT_NUMERAL_WIDTH_FRACTION = 0.78;

/**
 * Sizes the numerals for a ring.
 *
 * Height is bounded twice over: by the arc each digit owns (so neighbours stay
 * separate but partially visible above and below, as on a combination padlock)
 * and by the ring's width (so a glyph never overhangs the drum). Whichever
 * bound is tighter wins, which is what makes the generator safe for ring sizes
 * it has never seen.
 */
export function numeralLayout(
  config: Pick<RingConfig, 'radius' | 'thickness'>,
  options: NumeralLayoutOptions = {},
): NumeralLayout {
  const digitsPerRing = options.digitsPerRing ?? DIGITS_PER_RING;
  const stepAngle = digitStepAngle(digitsPerRing);
  const arcPerDigit = stepAngle * config.radius;

  const byArc = arcPerDigit * (options.heightFraction ?? DEFAULT_NUMERAL_HEIGHT_FRACTION);
  const byWidth =
    (config.thickness * (options.widthFraction ?? DEFAULT_NUMERAL_WIDTH_FRACTION)) / GLYPH_EM_WIDTH;
  const glyphHeight = Math.min(byArc, byWidth) * GLYPH_EM_HEIGHT;

  return {
    glyphHeight,
    glyphWidth: glyphHeight * GLYPH_EM_WIDTH,
    arcPerDigit,
    stepAngle,
  };
}

/**
 * Geometry-level checks on a ring configuration, complementing the structural
 * ones in `scene/validate.ts`. Returned rather than thrown, same as those.
 */
export function validateRingGeometry(
  config: RingConfig,
  options: NumeralLayoutOptions = {},
): string[] {
  const errors: string[] = [];
  if (!(config.radius > 0)) errors.push(`ring radius must be > 0, got ${config.radius}`);
  if (!(config.thickness > 0)) errors.push(`ring thickness must be > 0, got ${config.thickness}`);
  if (errors.length > 0) return errors;

  const layout = numeralLayout(config, options);
  if (layout.glyphHeight <= 0) errors.push('ring numerals would have no height');
  if (layout.glyphHeight > layout.arcPerDigit) {
    errors.push(
      `ring numerals (${layout.glyphHeight.toFixed(3)} m tall) would overlap their ` +
        `neighbours (${layout.arcPerDigit.toFixed(3)} m of arc per digit)`,
    );
  }
  if (layout.glyphWidth > config.thickness) {
    errors.push(
      `ring numerals (${layout.glyphWidth.toFixed(3)} m wide) would overhang the ` +
        `${config.thickness.toFixed(3)} m ring`,
    );
  }
  return errors;
}
