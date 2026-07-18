/**
 * Segment subdivision for outlines that are about to be bent.
 *
 * The numeral glyphs are extruded flat and then wrapped onto the ring drum,
 * with the glyph's y axis becoming arc length around the circumference. The
 * bend is exact per *vertex* — but the faces between vertices stay straight,
 * so a segment spanning a lot of y becomes a chord cutting inside the drum's
 * curve. On the copper-padlock ring the numbers are unforgiving: a full-height
 * stroke's chord sags ~0.019 m while the glyph stands only ~0.009 m proud, so
 * the middle of every long straight stroke sat *below* the drum surface. That
 * is exactly why 1, 7 and 4 — the digits made of long straight strokes — read
 * as sunk-in, while the arc-built digits (already flattened into many short
 * segments) never showed it.
 *
 * Subdividing by y-span puts vertices back on the curve. x-only segments (the
 * bar of a 7, the base of a 1) bend not at all and are left untouched, which
 * keeps the vertex count where it buys nothing.
 *
 * Pure maths, no three.js — same rules as the rest of `src/geometry/`.
 */

import type { Contour, Outline, Point2 } from './types.js';

/**
 * Inserts evenly spaced points so no segment spans more than `maxSpanY` in y.
 *
 * Endpoints are preserved exactly; inserted points lie on the original
 * segment, so the contour's shape (and its signed area, up to float noise) is
 * unchanged. The closing segment — last point back to first — is subdivided
 * too, since contours are implicitly closed.
 */
export function subdivideContourY(contour: Contour, maxSpanY: number): Contour {
  if (!(maxSpanY > 0)) throw new Error(`subdivideContourY: maxSpanY must be > 0, got ${maxSpanY}`);
  if (contour.length < 2) return contour;

  const result: Point2[] = [];
  for (let i = 0; i < contour.length; i += 1) {
    const a = contour[i]!;
    const b = contour[(i + 1) % contour.length]!;
    result.push(a);

    const pieces = Math.ceil(Math.abs(b.y - a.y) / maxSpanY);
    for (let step = 1; step < pieces; step += 1) {
      const t = step / pieces;
      result.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
    }
  }
  return result;
}

/** {@link subdivideContourY} over an outline's contour and every hole. */
export function subdivideOutlineY(outline: Outline, maxSpanY: number): Outline {
  return {
    contour: subdivideContourY(outline.contour, maxSpanY),
    holes: outline.holes.map((hole) => subdivideContourY(hole, maxSpanY)),
  };
}
