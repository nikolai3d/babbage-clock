/**
 * A procedural stroke font for the ten digits.
 *
 * Why a font in code rather than a texture atlas or an imported typeface:
 * the numerals have to survive being wrapped around a 1 m ring and read at ~7 m
 * with only placeholder materials, and no PBR or text assets exist yet. See
 * `docs/assets.md` for the full comparison.
 *
 * Glyphs are authored on a 1 x 1 em box centred on the origin: y runs from
 * -0.5 (baseline) to +0.5 (cap height), x from about -0.32 to +0.32. Callers
 * scale the em box to metres. Everything here is pure maths — no three.js.
 */

import { strokeOutline } from './strokes.js';
import { ellipseArc, mapOutline, type Outline, type Point2 } from './types.js';

export interface GlyphOptions {
  /** Stroke weight in em. Legibility falls off below ~0.10 at reading distance. */
  readonly strokeWidth?: number;
  /** Segments per quarter turn when flattening arcs. */
  readonly arcSegments?: number;
}

export const DEFAULT_STROKE_WIDTH = 0.15;
const DEFAULT_ARC_SEGMENTS = 4;

/** Nominal em-box dimensions; the advance width the ring layout reserves. */
export const GLYPH_EM_HEIGHT = 1;
export const GLYPH_EM_WIDTH = 0.72;

interface Stroke {
  readonly path: readonly Point2[];
  readonly closed?: boolean;
}

/** Arc helper in em space; `turns` is measured in quarter turns for segment count. */
function arc(
  cx: number,
  cy: number,
  rx: number,
  ry: number,
  fromDeg: number,
  toDeg: number,
  quarterSegments: number,
): Point2[] {
  const sweep = Math.abs(toDeg - fromDeg) / 90;
  const segments = Math.max(2, Math.round(sweep * quarterSegments));
  return ellipseArc(cx, cy, rx, ry, (fromDeg * Math.PI) / 180, (toDeg * Math.PI) / 180, segments);
}

/**
 * Stroke definitions per digit.
 *
 * Shapes lean deliberately geometric — flat-topped 7, closed 4, straight-tailed
 * 9 — because engraved instrument numerals read better than a humanist face at
 * this size and because a mechanical look matches the reference image.
 */
function strokesFor(digit: number, q: number): Stroke[] {
  switch (digit) {
    case 0:
      return [{ path: arc(0, 0, 0.27, 0.47, 0, 360, q).slice(0, -1), closed: true }];
    case 1:
      return [
        { path: [pt(-0.2, 0.28), pt(-0.02, 0.5), pt(-0.02, -0.5)] },
        { path: [pt(-0.24, -0.5), pt(0.24, -0.5)] },
      ];
    case 2:
      return [
        {
          path: [...arc(0, 0.22, 0.27, 0.26, 195, -55, q), pt(-0.22, -0.5), pt(0.27, -0.5)],
        },
      ];
    case 3:
      return [
        // Two separate bowls rather than one polyline: the near-reversal where
        // they meet would otherwise fold the miter join into a visible notch.
        { path: arc(0, 0.25, 0.25, 0.24, 165, -85, q) },
        { path: arc(0, -0.23, 0.27, 0.26, 85, -170, q) },
      ];
    case 4:
      return [
        { path: [pt(0.11, 0.5), pt(-0.28, -0.09), pt(0.28, -0.09)] },
        { path: [pt(0.11, 0.5), pt(0.11, -0.5)] },
      ];
    case 5:
      return [
        {
          // The bowl's sweep runs all the way to -190 deg so its round end cap
          // lands back on the arc's own start, sealing the join. Stopping at
          // -165 left a sliver of a gap between cap and start — invisible in
          // 2D at text sizes, but as extruded relief it caught the light as a
          // stray facet on the drum.
          path: [
            pt(0.24, 0.5),
            pt(-0.21, 0.5),
            pt(-0.235, 0.06),
            ...arc(0, -0.18, 0.28, 0.3, 150, -190, q),
          ],
        },
      ];
    case 6:
      return [
        { path: [...arc(0, 0.1, 0.27, 0.4, 60, 182, q)] },
        { path: arc(0, -0.19, 0.26, 0.29, 0, 360, q).slice(0, -1), closed: true },
      ];
    case 7:
      return [{ path: [pt(-0.26, 0.5), pt(0.26, 0.5), pt(-0.05, -0.5)] }];
    case 8:
      return [
        { path: arc(0, 0.26, 0.22, 0.23, 0, 360, q).slice(0, -1), closed: true },
        { path: arc(0, -0.22, 0.26, 0.27, 0, 360, q).slice(0, -1), closed: true },
      ];
    case 9:
      // A rotated 6 — same construction, guaranteed to match its sibling.
      return strokesFor(6, q).map((stroke) => ({
        ...stroke,
        path: stroke.path.map((point) => pt(-point.x, -point.y)),
      }));
    default:
      throw new Error(`digitGlyph: digit must be 0-9, got ${digit}`);
  }
}

function pt(x: number, y: number): Point2 {
  return { x, y };
}

/** A filled disc as a single closed contour, wound counter-clockwise. */
function disc(cx: number, cy: number, radius: number, segments: number): Outline {
  // `ellipseArc` repeats the start point when it closes the loop; drop it, since
  // a `Contour` is implicitly closed.
  const contour = ellipseArc(cx, cy, radius, radius, 0, 2 * Math.PI, segments).slice(0, -1);
  return { contour, holes: [] };
}

/** Vertical gap of each colon dot's centre from the em-box midline. */
const COLON_DOT_OFFSET = 0.2;
/** Colon dot radius as a fraction of the stroke width, so it reads with the numerals' weight. */
const COLON_DOT_RADIUS_FRACTION = 0.9;

/**
 * The colon a static separator ring carries, as two filled dots.
 *
 * Authored on the same 1 em box as the digits (see the module header) so it
 * scales identically when a caller maps the box to metres — the separator wants
 * a colon the same size as the numerals around it. Two solid dots rather than
 * stroked rings: a separator never rotates, so only this one reading-line glyph
 * is ever seen, and a solid dot reads as punctuation where a hollow ring would
 * read as a tiny `0`.
 */
export function colonGlyph(options: GlyphOptions = {}): Outline[] {
  const strokeWidth = options.strokeWidth ?? DEFAULT_STROKE_WIDTH;
  const quarterSegments = Math.max(1, options.arcSegments ?? DEFAULT_ARC_SEGMENTS);
  // A dot is a full turn: four quarters, so a segment count keyed to the same
  // knob the digits use keeps the colon as round as the bowls beside it.
  const segments = Math.max(8, quarterSegments * 4);
  const radius = strokeWidth * COLON_DOT_RADIUS_FRACTION;
  return [
    disc(0, COLON_DOT_OFFSET, radius, segments),
    disc(0, -COLON_DOT_OFFSET, radius, segments),
  ];
}

/**
 * Filled outlines for one digit, in em space.
 *
 * Strokes are returned as separate outlines rather than being unioned: they are
 * extruded as separate solids of the same material, so overlaps are invisible
 * and no 2D boolean is needed. Each individual outline is simple.
 */
export function digitGlyph(digit: number, options: GlyphOptions = {}): Outline[] {
  if (!Number.isInteger(digit) || digit < 0 || digit > 9) {
    throw new Error(`digitGlyph: digit must be an integer 0-9, got ${digit}`);
  }
  const width = options.strokeWidth ?? DEFAULT_STROKE_WIDTH;
  const quarterSegments = Math.max(1, options.arcSegments ?? DEFAULT_ARC_SEGMENTS);

  const outlines: Outline[] = [];
  for (const stroke of strokesFor(digit, quarterSegments)) {
    const outline = strokeOutline(stroke.path, {
      width,
      ...(stroke.closed === undefined ? {} : { closed: stroke.closed }),
    });
    if (outline) outlines.push(outline);
  }
  return outlines;
}

/** Every glyph, indexed by digit. Useful for tests and atlas-style callers. */
export function digitGlyphs(options: GlyphOptions = {}): Outline[][] {
  const glyphs: Outline[][] = [];
  for (let digit = 0; digit <= 9; digit += 1) glyphs.push(digitGlyph(digit, options));
  return glyphs;
}

/** Axis-aligned bounds of a glyph, including its stroke weight. */
export function glyphBounds(outlines: readonly Outline[]): {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
} {
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const outline of outlines) {
    for (const point of outline.contour) {
      minX = Math.min(minX, point.x);
      maxX = Math.max(maxX, point.x);
      minY = Math.min(minY, point.y);
      maxY = Math.max(maxY, point.y);
    }
  }
  return { minX, maxX, minY, maxY };
}

/** Scales and translates a glyph's outlines, e.g. from em space into metres. */
export function transformGlyph(
  outlines: readonly Outline[],
  scale: number,
  offsetX = 0,
  offsetY = 0,
): Outline[] {
  return outlines.map((outline) =>
    mapOutline(outline, (point) => ({
      x: point.x * scale + offsetX,
      y: point.y * scale + offsetY,
    })),
  );
}
