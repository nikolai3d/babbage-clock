/**
 * Digit-ring geometry generators.
 *
 * Both generators are functions of `RingConfig`, never of a fixed mesh: a scene
 * that asks for six rings of a different radius gets correctly sized drums and
 * correctly sized numerals with no code change. That is the load-bearing
 * property this bead had to deliver.
 */

import * as THREE from 'three';
import {
  colonGlyph,
  digitGlyph,
  transformGlyph,
  type GlyphOptions,
} from '../../geometry/digitGlyphs.js';
import {
  digitAngle,
  numeralLayout,
  readingAngleForAxis,
  ringPlaneAxes,
  validateRingGeometry,
  type NumeralLayoutOptions,
  type SeparatorGlyph,
} from '../../geometry/ringLayout.js';
import {
  deformPositions,
  extrudeOutlines,
  mergeAndDispose,
  subdivideTrianglesY,
} from './extrude.js';
import { SURFACE_UNIT_METRES, latheUvToSurface } from './uv.js';
import { subdivideOutlineY } from '../../geometry/subdivide.js';
import type { Outline } from '../../geometry/types.js';
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
  // `LatheGeometry` spans 0…1 around the revolution and 0…1 along the profile.
  // Restated in surface units so a tiled material repeats at the documented
  // rate rather than once per drum, however big the drum is.
  latheUvToSurface(geometry, profile);
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
  const bend = drumBendFor(config, layout.glyphHeight, options);
  const readingAngle = readingAngleForAxis(config.axis);

  const glyphOptions: GlyphOptions = {
    ...(options.strokeWidth === undefined ? {} : { strokeWidth: options.strokeWidth }),
    ...(options.arcSegments === undefined ? {} : { arcSegments: options.arcSegments }),
  };

  const parts: THREE.BufferGeometry[] = [];
  for (let index = 0; index < digits.length; index += 1) {
    const digit = digits[index]!;
    const outlines = transformGlyph(digitGlyph(digit, glyphOptions), layout.glyphHeight);
    const angle = digitAngle(index, digits.length, readingAngle);
    parts.push(engraveGlyphOntoDrum(outlines, angle, bend));
  }

  const merged = mergeAndDispose(parts);
  merged.name = 'ring:numerals';
  return merged;
}

/**
 * The static separator glyph — a colon — engraved once at the reading line.
 *
 * A separator is a drum like the digit rings and carries the same relief mark,
 * but it never rotates, so only this one reading-line glyph is ever seen and it
 * is engraved at the reading angle rather than around the whole circumference.
 * It sizes the colon with the ring's default (ten-digit) numeral layout so the
 * mark matches the numerals on the drums beside it, and runs through the same
 * bend as the numerals so it shades and tiles identically.
 */
export function createSeparatorGlyphGeometry(
  config: RingConfig,
  glyph: SeparatorGlyph = 'colon',
  options: RingNumeralOptions = {},
): THREE.BufferGeometry {
  if (glyph !== 'colon') {
    throw new Error(`createSeparatorGlyphGeometry: unsupported separator glyph "${String(glyph)}"`);
  }

  const layoutOptions: NumeralLayoutOptions = {
    ...(options.heightFraction === undefined ? {} : { heightFraction: options.heightFraction }),
    ...(options.widthFraction === undefined ? {} : { widthFraction: options.widthFraction }),
  };
  const layout = numeralLayout(config, layoutOptions);
  const bend = drumBendFor(config, layout.glyphHeight, options);
  const readingAngle = readingAngleForAxis(config.axis);

  const glyphOptions: GlyphOptions = {
    ...(options.strokeWidth === undefined ? {} : { strokeWidth: options.strokeWidth }),
    ...(options.arcSegments === undefined ? {} : { arcSegments: options.arcSegments }),
  };

  const outlines = transformGlyph(colonGlyph(glyphOptions), layout.glyphHeight);
  const geometry = engraveGlyphOntoDrum(outlines, readingAngle, bend);
  geometry.name = 'ring:separator';
  return geometry;
}

/** How a flat glyph is bent onto one drum: relief, sink, radius, axes and the sag bound. */
interface DrumBend {
  readonly relief: number;
  readonly sink: number;
  readonly radius: number;
  readonly axis: Axis;
  readonly uAxis: Axis;
  readonly vAxis: Axis;
  readonly maxSpanY: number;
}

/** Resolves the drum-bend parameters shared by the numerals and the separators. */
function drumBendFor(
  config: RingConfig,
  glyphHeight: number,
  options: Pick<RingNumeralOptions, 'relief' | 'sinkFraction'>,
): DrumBend {
  const radius = config.radius;
  const relief = options.relief ?? Math.max(radius * 0.012, glyphHeight * 0.06);
  const sink = relief * (options.sinkFraction ?? DEFAULT_SINK_FRACTION);
  const [uAxis, vAxis] = ringPlaneAxes(config.axis);

  // Glyph y becomes arc length when the glyph is bent onto the drum, and the
  // bend is exact only at vertices — a segment spanning too much y becomes a
  // chord sagging inside the drum's curve. Bound the sag to a small fraction
  // of the relief so straight strokes track the surface as faithfully as the
  // flattened arcs always did. (Full-height strokes used to sag ~2x the whole
  // relief, which sank the middles of 1, 7 and 4 below the drum.)
  const maxSag = relief * 0.08;
  const maxBendAngle = 2 * Math.acos(Math.max(0, 1 - maxSag / radius));

  return { relief, sink, radius, axis: config.axis, uAxis, vAxis, maxSpanY: radius * maxBendAngle };
}

/**
 * Extrudes one flat glyph — outlines already scaled to metres — and bends it
 * onto the drum surface at `angle`, returning owned geometry.
 *
 * `angle` is where the glyph's baseline centre lands around the circumference:
 * the reading angle plus, for a numeral, its per-digit offset. Shared by the
 * numerals and the static separators so both engrave the same way.
 */
function engraveGlyphOntoDrum(
  outlinesInMetres: readonly Outline[],
  angle: number,
  bend: DrumBend,
): THREE.BufferGeometry {
  const { relief, sink, radius, axis, uAxis, vAxis, maxSpanY } = bend;

  const outlines = outlinesInMetres.map((outline) => subdivideOutlineY(outline, maxSpanY));
  // Outline subdivision bounds the walls; the triangle pass bounds the cap
  // diagonals earcut keeps regardless of how finely the outline is divided.
  const geometry = subdivideTrianglesY(extrudeOutlines(outlines, { depth: relief }), maxSpanY);

  // Flat glyph -> cylinder: glyph width runs along the ring axis, glyph height
  // runs around the circumference (so digits scroll past the reading line),
  // glyph depth becomes radial relief.
  //
  // The UVs are restated in the same breath, and that is not tidiness. The
  // extruder writes UVs for the *flat* profile — the glyph as it was before it
  // was bent — so a texture applied to the `numerals` slot would be stretched
  // around the curve and sheared across the extrusion walls. What is wanted is
  // the cylindrical frame the drum itself lives in: `u` is arc length around
  // the drum, `v` is distance along the ring axis. Because `theta` is known
  // analytically here, that is exact rather than fitted, and it is continuous
  // with `createRingBodyGeometry` — the marks and the drum under them share one
  // unbroken cylindrical parameterisation, so a material tiled across both lines
  // up.
  deformPositions(geometry, (point, uv) => {
    const along = point.x;
    const height = point.y;
    const depth = point.z;
    const theta = angle - height / radius;
    const r = radius - sink + depth;
    point.set(0, 0, 0);
    point[axis] = along;
    point[uAxis] = r * Math.cos(theta);
    point[vAxis] = r * Math.sin(theta);
    // Arc length at the drum surface, not at `r`: the relief is a fraction of a
    // percent of the radius, and measuring at the surface keeps the glyph faces
    // and their side walls on one consistent density.
    uv.set((theta * radius) / SURFACE_UNIT_METRES, along / SURFACE_UNIT_METRES);
  });

  return geometry;
}

/** Rotates a Y-aligned primitive so its length runs along `axis`. */
export function alignToAxis(geometry: THREE.BufferGeometry, axis: Axis): void {
  if (axis === 'x') geometry.rotateZ(Math.PI / 2);
  else if (axis === 'z') geometry.rotateX(Math.PI / 2);
}
