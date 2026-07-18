import { describe, expect, it } from 'vitest';
import { strokeOutline, strokeOutlines } from './strokes.js';
import { signedArea } from './types.js';

const line = (length: number) => [
  { x: 0, y: 0 },
  { x: length, y: 0 },
];

describe('strokeOutline', () => {
  it('gives a straight stroke the area of its rectangle plus its caps', () => {
    const outline = strokeOutline(line(2), { width: 0.2 })!;
    const area = Math.abs(signedArea(outline.contour));
    const rectangle = 2 * 0.2;
    const caps = Math.PI * 0.1 * 0.1;

    expect(area).toBeGreaterThan(rectangle);
    expect(area).toBeLessThan(rectangle + caps * 1.2);
  });

  it('scales area linearly with width', () => {
    const thin = Math.abs(signedArea(strokeOutline(line(2), { width: 0.1 })!.contour));
    const thick = Math.abs(signedArea(strokeOutline(line(2), { width: 0.2 })!.contour));
    expect(thick / thin).toBeGreaterThan(1.8);
    expect(thick / thin).toBeLessThan(2.2);
  });

  it('turns a closed path into a ring with a hole', () => {
    const square = [
      { x: -1, y: -1 },
      { x: 1, y: -1 },
      { x: 1, y: 1 },
      { x: -1, y: 1 },
    ];
    const outline = strokeOutline(square, { width: 0.2, closed: true })!;

    expect(outline.holes).toHaveLength(1);
    const outer = Math.abs(signedArea(outline.contour));
    const inner = Math.abs(signedArea(outline.holes[0]!));
    expect(outer).toBeCloseTo(2.2 * 2.2, 6);
    expect(inner).toBeCloseTo(1.8 * 1.8, 6);
  });

  it('keeps the hole wound opposite the contour', () => {
    const circle = Array.from({ length: 24 }, (_, i) => {
      const a = (i / 24) * Math.PI * 2;
      return { x: Math.cos(a), y: Math.sin(a) };
    });
    const outline = strokeOutline(circle, { width: 0.2, closed: true })!;
    expect(Math.sign(signedArea(outline.contour))).toBe(-Math.sign(signedArea(outline.holes[0]!)));
  });

  it('survives duplicate points, which would otherwise give a zero-length normal', () => {
    const outline = strokeOutline(
      [
        { x: 0, y: 0 },
        { x: 0, y: 0 },
        { x: 1, y: 0 },
      ],
      { width: 0.1 },
    );
    expect(outline).toBeDefined();
    for (const point of outline!.contour) {
      expect(Number.isFinite(point.x)).toBe(true);
      expect(Number.isFinite(point.y)).toBe(true);
    }
  });

  it('clamps the miter on a hairpin instead of shooting off to infinity', () => {
    const hairpin = [
      { x: 0, y: 0 },
      { x: 1, y: 0 },
      { x: 0, y: 0.001 },
    ];
    const outline = strokeOutline(hairpin, { width: 0.2 })!;
    const furthest = Math.max(...outline.contour.map((p) => Math.hypot(p.x, p.y)));
    expect(furthest).toBeLessThan(2);
  });

  it('returns nothing for paths that cannot enclose area', () => {
    expect(strokeOutline([{ x: 0, y: 0 }], { width: 0.1 })).toBeUndefined();
    expect(strokeOutline(line(1), { width: 0 })).toBeUndefined();
    expect(strokeOutline(line(1), { width: -1 })).toBeUndefined();
    expect(strokeOutline(line(1), { width: 0.1, closed: true })).toBeUndefined();
  });
});

describe('strokeOutlines', () => {
  it('skips degenerate paths rather than failing the whole glyph', () => {
    const outlines = strokeOutlines([line(1), [{ x: 0, y: 0 }]], { width: 0.1 });
    expect(outlines).toHaveLength(1);
  });
});
