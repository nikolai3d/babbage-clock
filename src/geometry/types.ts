/**
 * Shared 2D primitives for the procedural geometry generators.
 *
 * Everything under `src/geometry/` is pure maths: no three.js, no DOM. The
 * generators here produce *outlines* — closed 2D contours in metres — and
 * `src/render/geometry/` is the only place that turns them into
 * `BufferGeometry`. That split is what makes tooth profiles, digit glyphs and
 * ring angle mapping unit-testable without a WebGL context.
 */

export interface Point2 {
  readonly x: number;
  readonly y: number;
}

/**
 * A closed polygon, implicitly closed: the last point joins back to the first
 * and must not be repeated.
 */
export type Contour = readonly Point2[];

/** A filled region: one outer contour with zero or more holes punched in it. */
export interface Outline {
  readonly contour: Contour;
  readonly holes: readonly Contour[];
}

/** Signed area; positive when the contour winds counter-clockwise. */
export function signedArea(contour: Contour): number {
  let total = 0;
  for (let i = 0; i < contour.length; i += 1) {
    const a = contour[i]!;
    const b = contour[(i + 1) % contour.length]!;
    total += a.x * b.y - b.x * a.y;
  }
  return total / 2;
}

/** True when no two consecutive points coincide and the contour has area. */
export function isDegenerate(contour: Contour, epsilon = 1e-9): boolean {
  if (contour.length < 3) return true;
  return Math.abs(signedArea(contour)) <= epsilon;
}

/** Samples an axis-aligned ellipse arc; angles in radians, `a1` may be < `a0`. */
export function ellipseArc(
  cx: number,
  cy: number,
  rx: number,
  ry: number,
  a0: number,
  a1: number,
  segments: number,
): Point2[] {
  const count = Math.max(1, Math.round(segments));
  const points: Point2[] = [];
  for (let i = 0; i <= count; i += 1) {
    const a = a0 + ((a1 - a0) * i) / count;
    points.push({ x: cx + rx * Math.cos(a), y: cy + ry * Math.sin(a) });
  }
  return points;
}

/** Maps every point of an outline, preserving hole structure. */
export function mapOutline(outline: Outline, fn: (point: Point2) => Point2): Outline {
  return {
    contour: outline.contour.map(fn),
    holes: outline.holes.map((hole) => hole.map(fn)),
  };
}

export const degrees = (value: number): number => (value * Math.PI) / 180;
