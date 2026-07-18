/**
 * Parametric spur-gear profile generation — pure maths, no three.js.
 *
 * The flanks are true involutes of the base circle (`r_base = r_pitch cos α`),
 * which is what makes the teeth look like machined gears rather than saw teeth,
 * and what would let a later bead mesh two of these together at their pitch
 * circles without the geometry lying about where contact happens.
 *
 * Everything is in metres. The profile lies in the XY plane; the extruder in
 * `src/render/geometry/gear.ts` sweeps it along Z and stands it up so the gear
 * spins about +Y.
 */

import { degrees, type Contour, type Outline, type Point2 } from './types.js';

export type GearSpokeStyle = 'solid' | 'spoke5' | 'spoke6' | 'crescent';

export const GEAR_SPOKE_STYLES: readonly GearSpokeStyle[] = [
  'solid',
  'spoke5',
  'spoke6',
  'crescent',
];

export interface GearToothParams {
  /** Number of teeth. Involute profiles degenerate below about 7. */
  readonly teeth: number;
  /** Pitch radius in metres — where the tooth thickness equals half the pitch. */
  readonly radius: number;
  /** Pressure angle in degrees. 20 is the modern standard; 14.5 looks older. */
  readonly pressureAngleDeg?: number;
  /** Tip height as a multiple of the module (m = 2 * radius / teeth). */
  readonly addendumFactor?: number;
  /** Root depth as a multiple of the module. */
  readonly dedendumFactor?: number;
  /** Samples along each involute flank. */
  readonly flankSegments?: number;
  /** Samples across the tip land. */
  readonly tipSegments?: number;
  /** Samples across the root gap between two teeth. */
  readonly rootSegments?: number;
  /**
   * Upper bound on tooth height as a fraction of the pitch radius.
   *
   * The module (2 * radius / teeth) grows as the tooth count falls, so a
   * textbook addendum on a 10-tooth wheel produces flower petals rather than
   * teeth. These wheels are decorative, so height is clamped and the look stays
   * consistent from 10 teeth to 60.
   */
  readonly maxToothFraction?: number;
}

export interface GearBodyParams extends GearToothParams {
  /** Central bore for the arbor. 0 leaves the gear solid at the centre. */
  readonly boreRadius?: number;
  /** Outer radius of the central hub. */
  readonly hubRadius?: number;
  /** Inner radius of the rim; cutouts live between hub and rim. */
  readonly rimInnerRadius?: number;
  readonly spokeStyle?: GearSpokeStyle;
  /** Spoke thickness in metres, measured across the arm. */
  readonly spokeWidth?: number;
  /** Samples per quarter turn on cutout arcs. */
  readonly arcSegments?: number;
}

export const DEFAULT_PRESSURE_ANGLE_DEG = 20;
export const DEFAULT_ADDENDUM_FACTOR = 1;
export const DEFAULT_DEDENDUM_FACTOR = 1.25;
export const DEFAULT_MAX_TOOTH_FRACTION = 0.1;

/** Below this the tip land is a knife edge and the extrusion goes ugly. */
const MIN_TIP_HALF_ANGLE_FRACTION = 0.05;
/** Above this the root gap between adjacent teeth closes up. */
const MAX_ROOT_HALF_ANGLE_FRACTION = 0.45;

interface ResolvedTooth {
  readonly teeth: number;
  readonly pitchAngle: number;
  readonly baseRadius: number;
  readonly rootRadius: number;
  readonly tipRadius: number;
  readonly flankStartRadius: number;
  readonly halfAngleAt: (radius: number) => number;
}

/** Involute function: inv(α) = tan α − α, evaluated for the given radius. */
function involuteAt(baseRadius: number, radius: number): number {
  const ratio = baseRadius / radius;
  if (ratio >= 1) return 0;
  const alpha = Math.acos(ratio);
  return Math.tan(alpha) - alpha;
}

function resolveTooth(params: GearToothParams): ResolvedTooth {
  const teeth = Math.max(3, Math.round(params.teeth));
  const radius = params.radius;
  const module = (2 * radius) / teeth;
  const pressureAngle = degrees(params.pressureAngleDeg ?? DEFAULT_PRESSURE_ANGLE_DEG);
  const baseRadius = radius * Math.cos(pressureAngle);
  const pitchAngle = (Math.PI * 2) / teeth;

  const invPitch = involuteAt(baseRadius, radius);
  const halfAngleAt = (r: number): number =>
    pitchAngle / 4 + invPitch - involuteAt(baseRadius, Math.max(r, baseRadius));

  const maxTooth = radius * (params.maxToothFraction ?? DEFAULT_MAX_TOOTH_FRACTION);
  const addendum = Math.min((params.addendumFactor ?? DEFAULT_ADDENDUM_FACTOR) * module, maxTooth);
  const dedendum = Math.min(
    (params.dedendumFactor ?? DEFAULT_DEDENDUM_FACTOR) * module,
    maxTooth * 1.25,
  );

  const rootRadius = Math.max(radius * 0.15, radius - dedendum);

  // Shrink the addendum until the tip land is a real face rather than a point.
  // Small tooth counts and generous addenda otherwise produce a spike whose two
  // flanks cross, which is exactly the self-intersection this bead must avoid.
  const requestedTip = radius + addendum;
  const minTipHalf = pitchAngle * MIN_TIP_HALF_ANGLE_FRACTION;
  let tipRadius = requestedTip;
  if (halfAngleAt(tipRadius) < minTipHalf) {
    let low = radius;
    let high = requestedTip;
    for (let i = 0; i < 40; i += 1) {
      const mid = (low + high) / 2;
      if (halfAngleAt(mid) < minTipHalf) high = mid;
      else low = mid;
    }
    tipRadius = low;
  }

  return {
    teeth,
    pitchAngle,
    baseRadius,
    rootRadius,
    tipRadius,
    flankStartRadius: Math.max(rootRadius, baseRadius),
    halfAngleAt,
  };
}

function polar(radius: number, angle: number): Point2 {
  return { x: radius * Math.cos(angle), y: radius * Math.sin(angle) };
}

/**
 * The complete outer contour of a gear, wound counter-clockwise.
 *
 * One pass per tooth: up the left involute flank, across the tip land, down the
 * right flank, then round the root arc into the next tooth.
 */
export function gearToothProfile(params: GearToothParams): Point2[] {
  const tooth = resolveTooth(params);
  const flankSegments = Math.max(2, params.flankSegments ?? 5);
  const tipSegments = Math.max(1, params.tipSegments ?? 2);
  const rootSegments = Math.max(1, params.rootSegments ?? 3);

  const { pitchAngle, rootRadius, tipRadius, flankStartRadius, halfAngleAt } = tooth;
  const halfAtFlankStart = halfAngleAt(flankStartRadius);
  const halfAtTip = halfAngleAt(tipRadius);
  const dropsToRoot = flankStartRadius - rootRadius > 1e-6;

  const points: Point2[] = [];

  for (let i = 0; i < tooth.teeth; i += 1) {
    const centre = i * pitchAngle;

    if (dropsToRoot) points.push(polar(rootRadius, centre - halfAtFlankStart));

    for (let k = 0; k <= flankSegments; k += 1) {
      const r = flankStartRadius + ((tipRadius - flankStartRadius) * k) / flankSegments;
      points.push(polar(r, centre - halfAngleAt(r)));
    }

    for (let k = 1; k < tipSegments; k += 1) {
      const a = -halfAtTip + (2 * halfAtTip * k) / tipSegments;
      points.push(polar(tipRadius, centre + a));
    }

    for (let k = flankSegments; k >= 0; k -= 1) {
      const r = flankStartRadius + ((tipRadius - flankStartRadius) * k) / flankSegments;
      points.push(polar(r, centre + halfAngleAt(r)));
    }

    if (dropsToRoot) points.push(polar(rootRadius, centre + halfAtFlankStart));

    const gapStart = centre + halfAtFlankStart;
    const gapEnd = centre + pitchAngle - halfAtFlankStart;
    for (let k = 1; k < rootSegments; k += 1) {
      points.push(polar(rootRadius, gapStart + ((gapEnd - gapStart) * k) / rootSegments));
    }
  }

  return points;
}

/** Circle as a closed contour, wound counter-clockwise. */
export function circleContour(radius: number, segments: number): Point2[] {
  const count = Math.max(3, Math.round(segments));
  const points: Point2[] = [];
  for (let i = 0; i < count; i += 1) points.push(polar(radius, (i / count) * Math.PI * 2));
  return points;
}

/** Spoke count implied by a style; `solid` has none. */
export function spokeCountFor(style: GearSpokeStyle): number {
  switch (style) {
    case 'spoke5':
      return 5;
    case 'spoke6':
      return 6;
    case 'crescent':
      return 4;
    case 'solid':
      return 0;
  }
}

interface WebParams {
  readonly hubRadius: number;
  readonly rimInnerRadius: number;
  readonly spokeWidth: number;
  readonly arcSegments: number;
}

/** Angular half-width of an opening at `radius`, given constant-width spokes. */
function openingHalfAngle(radius: number, count: number, spokeWidth: number): number {
  const spokeHalf = Math.asin(Math.min(1, spokeWidth / 2 / Math.max(radius, 1e-6)));
  return Math.PI / count - spokeHalf;
}

/** Straight-sided sector openings between constant-width spokes. */
function spokeHoles(count: number, web: WebParams): Contour[] {
  const { hubRadius, rimInnerRadius, spokeWidth, arcSegments } = web;
  const outerHalf = openingHalfAngle(rimInnerRadius, count, spokeWidth);
  const innerHalf = openingHalfAngle(hubRadius, count, spokeWidth);
  if (outerHalf <= 0.02 || innerHalf <= 0.02) return [];

  const holes: Contour[] = [];
  for (let i = 0; i < count; i += 1) {
    const centre = (i / count) * Math.PI * 2 + Math.PI / count;
    const points: Point2[] = [];
    const outerSteps = Math.max(2, Math.round(((outerHalf * 2) / (Math.PI / 2)) * arcSegments));
    for (let k = 0; k <= outerSteps; k += 1) {
      points.push(polar(rimInnerRadius, centre - outerHalf + (2 * outerHalf * k) / outerSteps));
    }
    const innerSteps = Math.max(2, Math.round(((innerHalf * 2) / (Math.PI / 2)) * arcSegments));
    for (let k = innerSteps; k >= 0; k -= 1) {
      points.push(polar(hubRadius, centre - innerHalf + (2 * innerHalf * k) / innerSteps));
    }
    holes.push(points);
  }
  return holes;
}

/**
 * Kidney-shaped lightening cutouts: the same sector opening, but with the
 * radial extent tapering to nothing at both ends so the arms blend into hub and
 * rim instead of meeting them at a corner.
 */
function crescentHoles(count: number, web: WebParams): Contour[] {
  const { hubRadius, rimInnerRadius, spokeWidth, arcSegments } = web;
  const outerHalf = openingHalfAngle((hubRadius + rimInnerRadius) / 2, count, spokeWidth);
  if (outerHalf <= 0.05) return [];

  const mid = (hubRadius + rimInnerRadius) / 2;
  const steps = Math.max(6, Math.round(((outerHalf * 2) / (Math.PI / 2)) * arcSegments * 2));
  const endFraction = 0.22;

  const holes: Contour[] = [];
  for (let i = 0; i < count; i += 1) {
    const centre = (i / count) * Math.PI * 2 + Math.PI / count;
    const outer: Point2[] = [];
    const inner: Point2[] = [];
    for (let k = 0; k <= steps; k += 1) {
      const t = k / steps;
      const angle = centre - outerHalf + 2 * outerHalf * t;
      // Smooth taper at both ends of the sweep.
      const edge = Math.min(1, Math.min(t, 1 - t) / endFraction);
      const taper = edge * edge * (3 - 2 * edge);
      outer.push(polar(mid + (rimInnerRadius - mid) * taper, angle));
      inner.push(polar(mid - (mid - hubRadius) * taper, angle));
    }
    holes.push([...outer, ...inner.reverse()]);
  }
  return holes;
}

/**
 * The full gear cross-section: toothed outer contour plus bore, spoke or
 * crescent cutouts as holes.
 */
export function gearOutline(params: GearBodyParams): Outline {
  const errors = validateGearParams(params);
  if (errors.length > 0) {
    throw new Error(`Invalid gear parameters:\n  - ${errors.join('\n  - ')}`);
  }

  const contour = gearToothProfile(params);
  const arcSegments = Math.max(2, params.arcSegments ?? 6);
  const style = params.spokeStyle ?? 'solid';

  const geometry = resolveBodyRadii(params);
  const holes: Contour[] = [];

  if (geometry.boreRadius > 0) {
    // Reversed so the bore winds opposite the outer contour; extruders that
    // care about winding then read it unambiguously as a hole.
    holes.push(circleContour(geometry.boreRadius, Math.max(12, arcSegments * 6)).reverse());
  }

  const count = spokeCountFor(style);
  if (count > 0 && geometry.rimInnerRadius - geometry.hubRadius > geometry.spokeWidth * 0.5) {
    const web: WebParams = {
      hubRadius: geometry.hubRadius,
      rimInnerRadius: geometry.rimInnerRadius,
      spokeWidth: geometry.spokeWidth,
      arcSegments,
    };
    const cutouts = style === 'crescent' ? crescentHoles(count, web) : spokeHoles(count, web);
    for (const cutout of cutouts) holes.push([...cutout].reverse());
  }

  return { contour, holes };
}

interface ResolvedBody {
  readonly boreRadius: number;
  readonly hubRadius: number;
  readonly rimInnerRadius: number;
  readonly spokeWidth: number;
}

/** Fills in the body radii a caller left out, keeping them mutually consistent. */
export function resolveBodyRadii(params: GearBodyParams): ResolvedBody {
  const tooth = resolveTooth(params);
  const bore = params.boreRadius ?? params.radius * 0.12;
  const hub = params.hubRadius ?? Math.max(bore * 1.9, params.radius * 0.26);
  const rimInner = params.rimInnerRadius ?? tooth.rootRadius * 0.82;
  return {
    boreRadius: Math.max(0, bore),
    hubRadius: hub,
    rimInnerRadius: rimInner,
    spokeWidth: params.spokeWidth ?? params.radius * 0.16,
  };
}

/**
 * Everything that would produce degenerate or self-intersecting geometry.
 * Returned rather than thrown so a caller can report all problems at once, in
 * the same style as `validateSceneDefinition`.
 */
export function validateGearParams(params: GearBodyParams): string[] {
  const errors: string[] = [];

  if (!(params.radius > 0)) errors.push(`gear radius must be > 0, got ${params.radius}`);
  if (!Number.isFinite(params.teeth) || params.teeth < 3) {
    errors.push(`gear needs at least 3 teeth, got ${params.teeth}`);
  }
  const pressureAngle = params.pressureAngleDeg ?? DEFAULT_PRESSURE_ANGLE_DEG;
  if (pressureAngle <= 0 || pressureAngle >= 45) {
    errors.push(`gear pressure angle must lie in (0, 45) degrees, got ${pressureAngle}`);
  }
  if (errors.length > 0) return errors;

  const tooth = resolveTooth(params);
  const halfAtFlankStart = tooth.halfAngleAt(tooth.flankStartRadius);
  if (halfAtFlankStart >= tooth.pitchAngle * MAX_ROOT_HALF_ANGLE_FRACTION) {
    errors.push(
      `gear teeth (${params.teeth} at ${pressureAngle} deg) leave no root gap; ` +
        'reduce the pressure angle or the dedendum',
    );
  }
  if (tooth.rootRadius <= 0) errors.push('gear dedendum reaches past the centre');

  const body = resolveBodyRadii(params);
  if (body.boreRadius >= tooth.rootRadius) {
    errors.push(`gear bore (${body.boreRadius}) must stay inside the root radius`);
  }
  if (body.hubRadius <= body.boreRadius) {
    errors.push('gear hub radius must exceed the bore radius');
  }
  if (body.rimInnerRadius > tooth.rootRadius) {
    errors.push('gear rim inner radius must stay inside the root radius');
  }
  if (body.spokeWidth <= 0) errors.push('gear spoke width must be > 0');

  return errors;
}
