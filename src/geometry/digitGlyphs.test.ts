import { describe, expect, it } from 'vitest';
import {
  DEFAULT_STROKE_WIDTH,
  GLYPH_EM_WIDTH,
  colonGlyph,
  digitGlyph,
  digitGlyphs,
  glyphBounds,
  transformGlyph,
} from './digitGlyphs.js';
import { MITER_LIMIT } from './strokes.js';
import { signedArea } from './types.js';

describe('digitGlyph', () => {
  it('builds all ten digits', () => {
    const glyphs = digitGlyphs();
    expect(glyphs).toHaveLength(10);
    for (const glyph of glyphs) expect(glyph.length).toBeGreaterThan(0);
  });

  it('keeps every digit inside the em box it advertises', () => {
    // A stroked skeleton reaches half a stroke past its centre line, and a
    // sharp corner (the flag of a 1, the apex of a 4) reaches MITER_LIMIT
    // times that. The numeral layout leaves headroom for exactly this.
    const overshoot = (DEFAULT_STROKE_WIDTH / 2) * MITER_LIMIT + 1e-6;
    for (let digit = 0; digit <= 9; digit += 1) {
      const bounds = glyphBounds(digitGlyph(digit));
      expect(bounds.minY).toBeGreaterThanOrEqual(-0.5 - overshoot);
      expect(bounds.maxY).toBeLessThanOrEqual(0.5 + overshoot);
      expect(bounds.maxX - bounds.minX).toBeLessThanOrEqual(GLYPH_EM_WIDTH + overshoot);
    }
  });

  it('fills a meaningful fraction of its box for every digit', () => {
    // A digit that came out empty or hairline would still have valid bounds;
    // area is what catches a stroke that failed to offset.
    for (let digit = 0; digit <= 9; digit += 1) {
      const area = digitGlyph(digit).reduce(
        (total, outline) =>
          total +
          Math.abs(signedArea(outline.contour)) -
          outline.holes.reduce((h, hole) => h + Math.abs(signedArea(hole)), 0),
        0,
      );
      expect(area).toBeGreaterThan(0.05);
      expect(area).toBeLessThan(0.6);
    }
  });

  it('gives closed bowls a hole so they read as rings, not blobs', () => {
    expect(digitGlyph(0)[0]!.holes).toHaveLength(1);
    for (const outline of digitGlyph(8)) expect(outline.holes).toHaveLength(1);
    // An open stroke has no hole.
    expect(digitGlyph(7)[0]!.holes).toHaveLength(0);
  });

  it('draws 9 as a rotated 6, so the pair always matches', () => {
    const six = digitGlyph(6);
    const nine = digitGlyph(9);
    expect(nine).toHaveLength(six.length);
    for (let i = 0; i < six.length; i += 1) {
      const a = six[i]!.contour[0]!;
      const b = nine[i]!.contour[0]!;
      expect(b.x).toBeCloseTo(-a.x, 9);
      expect(b.y).toBeCloseTo(-a.y, 9);
    }
  });

  it('scales stroke weight without moving the skeleton', () => {
    const thin = glyphBounds(digitGlyph(1, { strokeWidth: 0.08 }));
    const thick = glyphBounds(digitGlyph(1, { strokeWidth: 0.24 }));
    expect(thick.maxX - thick.minX).toBeGreaterThan(thin.maxX - thin.minX);
  });

  it('spends more points on arcs when asked', () => {
    const coarse = digitGlyph(0, { arcSegments: 2 })[0]!.contour.length;
    const fine = digitGlyph(0, { arcSegments: 8 })[0]!.contour.length;
    expect(fine).toBeGreaterThan(coarse);
  });

  it('rejects anything that is not a single digit', () => {
    expect(() => digitGlyph(10)).toThrow(/0-9/);
    expect(() => digitGlyph(-1)).toThrow(/0-9/);
    expect(() => digitGlyph(1.5)).toThrow(/0-9/);
  });
});

describe('colonGlyph', () => {
  it('is two solid dots, no holes', () => {
    const glyph = colonGlyph();
    expect(glyph).toHaveLength(2);
    for (const outline of glyph) {
      // Solid, so it reads as a colon rather than a pair of tiny hollow zeros.
      expect(outline.holes).toHaveLength(0);
      // Wound counter-clockwise like the digit contours, so the extruder faces
      // it the same way.
      expect(signedArea(outline.contour)).toBeGreaterThan(0);
    }
  });

  it('stacks the dots symmetrically inside the em box', () => {
    const [top, bottom] = colonGlyph();
    const t = glyphBounds([top!]);
    const b = glyphBounds([bottom!]);

    // Mirror images about the em-box midline.
    expect(t.maxY).toBeCloseTo(-b.minY, 9);
    expect(t.minY).toBeCloseTo(-b.maxY, 9);
    // A colon, not a stacked blob: the dots are clear of each other.
    expect(t.minY).toBeGreaterThan(b.maxY);
    // Both dots stay inside the 1 em box the digits share.
    expect(t.maxY).toBeLessThanOrEqual(0.5);
    expect(b.minY).toBeGreaterThanOrEqual(-0.5);
  });

  it('takes its weight from the stroke width, like the numerals', () => {
    const thin = glyphBounds([colonGlyph({ strokeWidth: 0.08 })[0]!]);
    const thick = glyphBounds([colonGlyph({ strokeWidth: 0.24 })[0]!]);
    expect(thick.maxX - thick.minX).toBeGreaterThan(thin.maxX - thin.minX);
  });

  it('spends more points on the dots when asked for finer arcs', () => {
    const coarse = colonGlyph({ arcSegments: 2 })[0]!.contour.length;
    const fine = colonGlyph({ arcSegments: 12 })[0]!.contour.length;
    expect(fine).toBeGreaterThan(coarse);
  });
});

describe('transformGlyph', () => {
  it('scales and offsets contours and holes alike', () => {
    const scaled = transformGlyph(digitGlyph(0), 2, 1, -1);
    const bounds = glyphBounds(scaled);
    const original = glyphBounds(digitGlyph(0));

    expect(bounds.minX).toBeCloseTo(original.minX * 2 + 1, 9);
    expect(bounds.maxY).toBeCloseTo(original.maxY * 2 - 1, 9);
    expect(scaled[0]!.holes[0]!.length).toBe(digitGlyph(0)[0]!.holes[0]!.length);
  });
});
