import { describe, expect, it } from 'vitest';
import { subdivideContourY, subdivideOutlineY } from './subdivide.js';
import { signedArea, type Contour } from './types.js';

const square: Contour = [
  { x: 0, y: 0 },
  { x: 1, y: 0 },
  { x: 1, y: 1 },
  { x: 0, y: 1 },
];

function maxYSpan(contour: Contour): number {
  let max = 0;
  for (let i = 0; i < contour.length; i += 1) {
    const a = contour[i]!;
    const b = contour[(i + 1) % contour.length]!;
    max = Math.max(max, Math.abs(b.y - a.y));
  }
  return max;
}

describe('subdivideContourY', () => {
  it('bounds the y-span of every segment, closing edge included', () => {
    const result = subdivideContourY(square, 0.25);
    expect(maxYSpan(result)).toBeLessThanOrEqual(0.25 + 1e-12);
  });

  it('keeps original vertices and puts inserted points on the segment', () => {
    const result = subdivideContourY(square, 0.4);
    for (const point of square) {
      expect(result).toContainEqual(point);
    }
    // The vertical edge x=1 from y=0 to y=1 gains points at x exactly 1.
    for (const point of result.filter((p) => p.y > 0 && p.y < 1)) {
      expect(point.x === 0 || point.x === 1).toBe(true);
    }
  });

  it('preserves the shape: signed area is unchanged', () => {
    const before = signedArea(square);
    const after = signedArea(subdivideContourY(square, 0.1));
    expect(after).toBeCloseTo(before, 12);
  });

  it('leaves horizontal segments alone', () => {
    const bar: Contour = [
      { x: -3, y: 0 },
      { x: 3, y: 0 },
      { x: 3, y: 0.1 },
      { x: -3, y: 0.1 },
    ];
    // Long in x, tiny in y: nothing to gain by splitting, and it must not.
    expect(subdivideContourY(bar, 0.2)).toHaveLength(4);
  });

  it('rejects a non-positive span', () => {
    expect(() => subdivideContourY(square, 0)).toThrow(/maxSpanY/);
  });
});

describe('subdivideOutlineY', () => {
  it('subdivides holes with the same bound as the contour', () => {
    const outline = {
      contour: square,
      holes: [
        [
          { x: 0.25, y: 0.25 },
          { x: 0.75, y: 0.25 },
          { x: 0.75, y: 0.75 },
          { x: 0.25, y: 0.75 },
        ],
      ],
    };
    const result = subdivideOutlineY(outline, 0.2);
    expect(maxYSpan(result.contour)).toBeLessThanOrEqual(0.2 + 1e-12);
    expect(maxYSpan(result.holes[0]!)).toBeLessThanOrEqual(0.2 + 1e-12);
  });
});
