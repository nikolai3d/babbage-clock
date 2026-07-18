/**
 * Turns a stroked polyline into a filled outline.
 *
 * The digit glyphs are authored as centre-line strokes (a mechanical engraver's
 * mental model) rather than as filled outlines, because strokes are far easier
 * to author and to tune: one `strokeWidth` knob changes the weight of every
 * numeral at once. This module does the offsetting.
 */

import { signedArea, type Contour, type Outline, type Point2 } from './types.js';

export interface StrokeOptions {
  /** Full stroke width in the same units as the path. */
  readonly width: number;
  /** Closed strokes (an "0" bowl) become an outer contour plus a hole. */
  readonly closed?: boolean;
  /** Segments used for each round end cap of an open stroke. */
  readonly capSegments?: number;
}

/**
 * Miter joins are clamped to this multiple of the half width. Shallow joins —
 * which is all a flattened arc ever produces — are unaffected; a hairpin turn
 * degrades to a blunt corner instead of shooting off to infinity.
 *
 * It also bounds how far a stroked path can exceed its skeleton: a glyph
 * authored on a 1 em box can reach 1 + strokeWidth * MITER_LIMIT at a sharp
 * corner, which is why the numeral layout leaves headroom around each digit.
 */
export const MITER_LIMIT = 2;

const EPSILON = 1e-7;

/** Drops consecutive duplicate points, which would otherwise give a zero-length normal. */
function dedupe(path: readonly Point2[], closed: boolean): Point2[] {
  const points: Point2[] = [];
  for (const point of path) {
    const previous = points[points.length - 1];
    if (previous && Math.hypot(point.x - previous.x, point.y - previous.y) < EPSILON) continue;
    points.push(point);
  }
  if (closed && points.length > 1) {
    const first = points[0]!;
    const last = points[points.length - 1]!;
    if (Math.hypot(first.x - last.x, first.y - last.y) < EPSILON) points.pop();
  }
  return points;
}

function normalOf(from: Point2, to: Point2): Point2 {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const length = Math.hypot(dx, dy) || 1;
  return { x: -dy / length, y: dx / length };
}

/** Per-vertex offset direction and length multiplier (1 for ends, miter for joins). */
interface Offset {
  readonly normal: Point2;
  readonly scale: number;
}

function offsetsFor(points: readonly Point2[], closed: boolean): Offset[] {
  const count = points.length;
  const offsets: Offset[] = [];

  for (let i = 0; i < count; i += 1) {
    const previous = i === 0 ? (closed ? points[count - 1] : undefined) : points[i - 1];
    const next = i === count - 1 ? (closed ? points[0] : undefined) : points[i + 1];
    const current = points[i]!;

    const incoming = previous ? normalOf(previous, current) : undefined;
    const outgoing = next ? normalOf(current, next) : undefined;

    if (!incoming) {
      offsets.push({ normal: outgoing!, scale: 1 });
      continue;
    }
    if (!outgoing) {
      offsets.push({ normal: incoming, scale: 1 });
      continue;
    }

    const mx = incoming.x + outgoing.x;
    const my = incoming.y + outgoing.y;
    const length = Math.hypot(mx, my);
    if (length < EPSILON) {
      // A perfect reversal: fall back to the incoming normal rather than
      // producing a NaN direction.
      offsets.push({ normal: incoming, scale: 1 });
      continue;
    }

    const miter = { x: mx / length, y: my / length };
    const cos = miter.x * outgoing.x + miter.y * outgoing.y;
    const scale = cos > 1 / MITER_LIMIT ? 1 / cos : MITER_LIMIT;
    offsets.push({ normal: miter, scale });
  }

  return offsets;
}

function shift(point: Point2, offset: Offset, distance: number): Point2 {
  return {
    x: point.x + offset.normal.x * offset.scale * distance,
    y: point.y + offset.normal.y * offset.scale * distance,
  };
}

/** Half-disc of points sweeping from `fromAngle` to `toAngle` around `centre`. */
function capArc(
  centre: Point2,
  radius: number,
  fromAngle: number,
  toAngle: number,
  segments: number,
): Point2[] {
  const points: Point2[] = [];
  for (let i = 1; i < segments; i += 1) {
    const a = fromAngle + ((toAngle - fromAngle) * i) / segments;
    points.push({ x: centre.x + radius * Math.cos(a), y: centre.y + radius * Math.sin(a) });
  }
  return points;
}

/**
 * Expands a centre-line path into a fillable outline.
 *
 * Open paths get round end caps. Closed paths become an annulus: the contour is
 * whichever offset loop encloses the larger area, the other becomes its hole.
 * Returns `undefined` for paths that cannot produce area (fewer than two
 * distinct points, or a non-positive width).
 */
export function strokeOutline(
  path: readonly Point2[],
  options: StrokeOptions,
): Outline | undefined {
  const closed = options.closed ?? false;
  const capSegments = Math.max(2, options.capSegments ?? 4);
  const half = options.width / 2;
  if (!(half > 0)) return undefined;

  const points = dedupe(path, closed);
  if (points.length < 2) return undefined;
  if (closed && points.length < 3) return undefined;

  const offsets = offsetsFor(points, closed);
  const left = points.map((point, i) => shift(point, offsets[i]!, half));
  const right = points.map((point, i) => shift(point, offsets[i]!, -half));

  if (closed) {
    const leftArea = Math.abs(signedArea(left));
    const rightArea = Math.abs(signedArea(right));
    const outer = leftArea >= rightArea ? left : right;
    const inner = leftArea >= rightArea ? right : left;
    return { contour: outer, holes: [[...inner].reverse()] };
  }

  const first = points[0]!;
  const last = points[points.length - 1]!;
  const startNormal = offsets[0]!.normal;
  const endNormal = offsets[points.length - 1]!.normal;

  const endAngle = Math.atan2(endNormal.y, endNormal.x);
  const startAngle = Math.atan2(startNormal.y, startNormal.x);

  const contour: Point2[] = [
    ...left,
    // Round the tail: sweep from the left offset round to the right offset.
    ...capArc(last, half, endAngle, endAngle - Math.PI, capSegments),
    ...[...right].reverse(),
    // ...and the head, sweeping the other way so the cap bulges backwards.
    ...capArc(first, half, startAngle + Math.PI, startAngle, capSegments),
  ];

  return { contour, holes: [] };
}

/** Convenience: stroke several paths and drop the ones that produce no area. */
export function strokeOutlines(
  paths: readonly (readonly Point2[])[],
  options: StrokeOptions,
): Outline[] {
  const outlines: Outline[] = [];
  for (const path of paths) {
    const outline = strokeOutline(path, options);
    if (outline) outlines.push(outline);
  }
  return outlines;
}

/** Re-exported for tests and callers that build contours by hand. */
export type { Contour };
