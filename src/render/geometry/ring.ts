/**
 * Digit-ring geometry generators.
 *
 * Both generators are functions of `RingConfig`, never of a fixed mesh: a scene
 * that asks for six rings of a different radius gets correctly sized drums and
 * correctly sized numerals with no code change. That is the load-bearing
 * property this bead had to deliver.
 */

import * as THREE from 'three';
import { digitGlyph, transformGlyph, type GlyphOptions } from '../../geometry/digitGlyphs.js';
import {
  DIGITS_PER_RING,
  digitAngle,
  numeralLayout,
  readingAngleForAxis,
  ringPlaneAxes,
  validateRingGeometry,
  type NumeralLayoutOptions,
} from '../../geometry/ringLayout.js';
import { deformPositions, extrudeOutlines, mergeAndDispose } from './extrude.js';
import type { Axis, RingConfig } from '../../scene/types.js';

export interface RingBodyOptions {
  /** Bore radius as a fraction of the ring radius; the arbor passes through it. */
  readonly boreFraction?: number;
  /** Edge chamfer as a fraction of the ring width. */
  readonly chamferFraction?: number;
}

export interface RingNumeralOptions extends NumeralLayoutOptions, GlyphOptions {
  /** The digit set engraved around the drum. Defaults to 0-9. */
  readonly digits?: readonly number[];
  /** Height the numerals stand proud of the drum, in metres. */
  readonly relief?: number;
  /** How far the glyph base is sunk into the drum, as a fraction of the relief. */
  readonly sinkFraction?: number;
}

const DEFAULT_BORE_FRACTION = 0.62;
const DEFAULT_CHAMFER_FRACTION = 0.16;
const DEFAULT_SINK_FRACTION = 0.6;

export const DEFAULT_DIGIT_SET: readonly number[] = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];

/**
 * The drum itself: a chamfered cylindrical shell, bored through for the arbor,
 * already aligned to `config.axis`.
 */
export function createRingBodyGeometry(
  config: RingConfig,
  options: RingBodyOptions = {},
): THREE.BufferGeometry {
  const { radius, thickness, radialSegments, axis } = config;
  if (!(radius > 0) || !(thickness > 0)) {
    throw new Error(`createRingBodyGeometry: radius and thickness must be > 0`);
  }

  const bore = radius * (options.boreFraction ?? DEFAULT_BORE_FRACTION);
  const chamfer = Math.min(
    thickness * (options.chamferFraction ?? DEFAULT_CHAMFER_FRACTION),
    radius * 0.08,
    thickness * 0.45,
  );
  const half = thickness / 2;

  // A closed cross-section revolved about the axis: outer face, both chamfered
  // rims, both end faces and the bore, in one shell with no open edges.
  const profile = [
    new THREE.Vector2(bore, -half),
    new THREE.Vector2(radius - chamfer, -half),
    new THREE.Vector2(radius, -half + chamfer),
    new THREE.Vector2(radius, half - chamfer),
    new THREE.Vector2(radius - chamfer, half),
    new THREE.Vector2(bore, half),
    new THREE.Vector2(bore, -half),
  ];

  const geometry = new THREE.LatheGeometry(profile, Math.max(8, radialSegments));
  alignToAxis(geometry, axis);
  geometry.name = 'ring:body';
  return geometry;
}

/**
 * Every numeral of one ring, merged into a single geometry and bent onto the
 * drum surface.
 *
 * Merging matters: ten digits of two or three strokes each would otherwise be
 * thirty draw calls per ring. Digit `d` is engraved at `readingAngle + d *
 * step`, which is precisely the angle `ClockSceneView` rotates to when it wants
 * to show `d`.
 */
export function createRingNumeralsGeometry(
  config: RingConfig,
  options: RingNumeralOptions = {},
): THREE.BufferGeometry {
  const digits = options.digits ?? DEFAULT_DIGIT_SET;
  if (digits.length === 0) throw new Error('createRingNumeralsGeometry: empty digit set');

  const layoutOptions: NumeralLayoutOptions = {
    digitsPerRing: digits.length,
    ...(options.heightFraction === undefined ? {} : { heightFraction: options.heightFraction }),
    ...(options.widthFraction === undefined ? {} : { widthFraction: options.widthFraction }),
  };

  const errors = validateRingGeometry(config, layoutOptions);
  if (errors.length > 0) {
    throw new Error(`Invalid ring numerals:\n  - ${errors.join('\n  - ')}`);
  }

  const layout = numeralLayout(config, layoutOptions);
  const relief = options.relief ?? Math.max(config.radius * 0.012, layout.glyphHeight * 0.06);
  const sink = relief * (options.sinkFraction ?? DEFAULT_SINK_FRACTION);
  const readingAngle = readingAngleForAxis(config.axis);
  const [uAxis, vAxis] = ringPlaneAxes(config.axis);
  const axis = config.axis;
  const radius = config.radius;

  const glyphOptions: GlyphOptions = {
    ...(options.strokeWidth === undefined ? {} : { strokeWidth: options.strokeWidth }),
    ...(options.arcSegments === undefined ? {} : { arcSegments: options.arcSegments }),
  };

  const parts: THREE.BufferGeometry[] = [];
  for (let index = 0; index < digits.length; index += 1) {
    const digit = digits[index]!;
    const outlines = transformGlyph(digitGlyph(digit, glyphOptions), layout.glyphHeight);
    const geometry = extrudeOutlines(outlines, { depth: relief });
    const angle = digitAngle(index, digits.length, readingAngle);

    // Flat glyph -> cylinder: glyph width runs along the ring axis, glyph
    // height runs around the circumference (so digits scroll past the reading
    // line), glyph depth becomes radial relief.
    deformPositions(geometry, (point) => {
      const along = point.x;
      const height = point.y;
      const depth = point.z;
      const theta = angle - height / radius;
      const r = radius - sink + depth;
      point.set(0, 0, 0);
      point[axis] = along;
      point[uAxis] = r * Math.cos(theta);
      point[vAxis] = r * Math.sin(theta);
    });

    parts.push(geometry);
  }

  const merged = mergeAndDispose(parts);
  merged.name = 'ring:numerals';
  return merged;
}

/** Convenience for callers that want the layout without building geometry. */
export { numeralLayout, DIGITS_PER_RING };

/** Rotates a Y-aligned primitive so its length runs along `axis`. */
export function alignToAxis(geometry: THREE.BufferGeometry, axis: Axis): void {
  if (axis === 'x') geometry.rotateZ(Math.PI / 2);
  else if (axis === 'z') geometry.rotateX(Math.PI / 2);
}
