import { describe, expect, it } from 'vitest';
import {
  DIGITS_PER_RING,
  digitAngle,
  digitStepAngle,
  numeralLayout,
  physicalRingCount,
  readingAngleForAxis,
  ringAngleForDigit,
  ringAxisOffset,
  ringPlaneAxes,
  ringStackSlots,
  ringStackSpan,
  validateRingGeometry,
} from './ringLayout.js';
import { copperPadlockScene } from '../scene/scenes/copperPadlock.js';
import { slateOrreryScene } from '../scene/scenes/slateOrrery.js';
import type { RingConfig } from '../scene/types.js';

const TWO_PI = Math.PI * 2;

const wrap = (angle: number): number => ((angle % TWO_PI) + TWO_PI) % TWO_PI;

describe('digit angles', () => {
  it('spaces ten digits 36 degrees apart', () => {
    expect(digitStepAngle()).toBeCloseTo((36 * Math.PI) / 180, 12);
    expect(digitStepAngle(DIGITS_PER_RING)).toBe(TWO_PI / 10);
  });

  it('supports digit sets other than ten', () => {
    expect(digitStepAngle(6)).toBeCloseTo(TWO_PI / 6, 12);
    expect(digitStepAngle(12)).toBeCloseTo(TWO_PI / 12, 12);
  });

  it('rejects a nonsensical digit count', () => {
    expect(() => digitStepAngle(0)).toThrow(/positive integer/);
    expect(() => digitStepAngle(2.5)).toThrow(/positive integer/);
  });

  /**
   * The contract the whole numeral system rests on: engraving a digit at
   * `digitAngle` and rotating the ring by `ringAngleForDigit` must land that
   * digit exactly on the reading line.
   */
  it.each([0, 1, 2, 3, 4, 5, 6, 7, 8, 9])('brings digit %i to the reading line', (digit) => {
    for (const axis of ['x', 'y', 'z'] as const) {
      const reading = readingAngleForAxis(axis);
      const engraved = digitAngle(digit, DIGITS_PER_RING, reading);
      expect(wrap(engraved + ringAngleForDigit(digit, DIGITS_PER_RING))).toBeCloseTo(
        wrap(reading),
        12,
      );
    }
  });

  it('leaves neighbouring digits one step either side', () => {
    const step = digitStepAngle();
    expect(digitAngle(4) - digitAngle(3)).toBeCloseTo(step, 12);
    expect(digitAngle(5) - digitAngle(3)).toBeCloseTo(2 * step, 12);
  });
});

describe('ringPlaneAxes', () => {
  it('orders the plane axes so a positive rotation carries u towards v', () => {
    expect(ringPlaneAxes('x')).toEqual(['y', 'z']);
    expect(ringPlaneAxes('y')).toEqual(['z', 'x']);
    expect(ringPlaneAxes('z')).toEqual(['x', 'y']);
  });
});

describe('ring stack layout', () => {
  it('centres the stack on the origin', () => {
    const offsets = Array.from({ length: 7 }, (_, i) => ringAxisOffset(i, 7, 0.5));
    expect(offsets[0]! + offsets[6]!).toBeCloseTo(0, 12);
    expect(offsets[1]! - offsets[0]!).toBeCloseTo(0.5, 12);
  });

  it('handles a single ring', () => {
    expect(ringAxisOffset(0, 1, 0.5)).toBe(0);
  });

  it('measures the span from the outer faces, not the centres', () => {
    expect(ringStackSpan({ count: 7, spacing: 0.5, thickness: 0.42 })).toBeCloseTo(3.42, 12);
    expect(ringStackSpan({ count: 1, spacing: 0.5, thickness: 0.42 })).toBeCloseTo(0.42, 12);
  });

  it('counts separators as physical positions in the span', () => {
    const separators = [{ afterRing: 3 }, { afterRing: 5 }];
    expect(physicalRingCount({ count: 7 })).toBe(7);
    expect(physicalRingCount({ count: 7, separators })).toBe(9);
    // Nine positions now: (9 - 1) * 0.5 + 0.42.
    expect(ringStackSpan({ count: 7, spacing: 0.5, thickness: 0.42, separators })).toBeCloseTo(
      4.42,
      12,
    );
  });
});

describe('ringStackSlots', () => {
  it('is every digit ring, in order, when no separators are declared', () => {
    const slots = ringStackSlots(7);
    expect(slots).toHaveLength(7);
    expect(slots.flatMap((slot) => (slot.kind === 'digit' ? [slot.digitIndex] : []))).toEqual([
      0, 1, 2, 3, 4, 5, 6,
    ]);
  });

  it('interleaves colons at the HHH:MM:SS boundaries without shifting digit indices', () => {
    const slots = ringStackSlots(7, [{ afterRing: 3 }, { afterRing: 5 }]);
    expect(slots.map((slot) => slot.kind)).toEqual([
      'digit',
      'digit',
      'digit',
      'separator',
      'digit',
      'digit',
      'separator',
      'digit',
      'digit',
    ]);
    // The seven digit rings still carry indices 0..6 in order, so the mechanism
    // ring a drum is driven by is unchanged by the separators around it.
    expect(slots.flatMap((slot) => (slot.kind === 'digit' ? [slot.digitIndex] : []))).toEqual([
      0, 1, 2, 3, 4, 5, 6,
    ]);
  });

  it('defaults a separator to a colon', () => {
    const slots = ringStackSlots(2, [{ afterRing: 1 }]);
    expect(slots.find((slot) => slot.kind === 'separator')).toEqual({
      kind: 'separator',
      glyph: 'colon',
    });
  });

  it('places a separator at either end when asked (afterRing 0 or count)', () => {
    const slots = ringStackSlots(2, [{ afterRing: 0 }, { afterRing: 2 }]);
    expect(slots.map((slot) => slot.kind)).toEqual(['separator', 'digit', 'digit', 'separator']);
  });

  it('stacks two separators declared at the same boundary', () => {
    const slots = ringStackSlots(2, [{ afterRing: 1 }, { afterRing: 1 }]);
    expect(slots.map((slot) => slot.kind)).toEqual(['digit', 'separator', 'separator', 'digit']);
  });

  it('still emits an out-of-range separator, so the physical count never lies', () => {
    // `scene/validate.ts` rejects an afterRing outside [0, count]; the layout
    // stays robust regardless and keeps physicalRingCount === count + separators,
    // so a bad scene can never make the slot list disagree with the span.
    const separators = [{ afterRing: 9 }];
    const slots = ringStackSlots(3, separators);
    expect(slots.filter((slot) => slot.kind === 'separator')).toHaveLength(1);
    expect(slots).toHaveLength(physicalRingCount({ count: 3, separators }));
  });
});

describe('numeralLayout', () => {
  it('fits ten digits around the circumference with room between them', () => {
    for (const scene of [copperPadlockScene, slateOrreryScene]) {
      const layout = numeralLayout(scene.rings);
      expect(layout.glyphHeight).toBeGreaterThan(0);
      expect(layout.glyphHeight).toBeLessThan(layout.arcPerDigit);
      expect(layout.glyphWidth).toBeLessThan(scene.rings.thickness);
    }
  });

  it('scales with the ring, so a bigger ring gets bigger numerals', () => {
    const small = numeralLayout({ radius: 0.5, thickness: 1 });
    const large = numeralLayout({ radius: 1.5, thickness: 3 });
    expect(large.glyphHeight).toBeCloseTo(small.glyphHeight * 3, 9);
  });

  it('lets the narrower ring win when width is the binding constraint', () => {
    const wide = numeralLayout({ radius: 1, thickness: 1 });
    const narrow = numeralLayout({ radius: 1, thickness: 0.2 });
    expect(narrow.glyphHeight).toBeLessThan(wide.glyphHeight);
    expect(narrow.glyphWidth).toBeLessThan(0.2);
  });

  it('reserves proportionally more arc for a larger digit set', () => {
    const ten = numeralLayout({ radius: 1, thickness: 1 });
    const twelve = numeralLayout({ radius: 1, thickness: 1 }, { digitsPerRing: 12 });
    expect(twelve.arcPerDigit).toBeLessThan(ten.arcPerDigit);
  });
});

describe('validateRingGeometry', () => {
  const base: RingConfig = copperPadlockScene.rings;

  it('accepts both shipped scenes', () => {
    expect(validateRingGeometry(copperPadlockScene.rings)).toEqual([]);
    expect(validateRingGeometry(slateOrreryScene.rings)).toEqual([]);
  });

  it('rejects degenerate rings', () => {
    expect(validateRingGeometry({ ...base, radius: 0 })).toContainEqual(
      expect.stringContaining('radius'),
    );
    expect(validateRingGeometry({ ...base, thickness: -1 })).toContainEqual(
      expect.stringContaining('thickness'),
    );
  });

  it('rejects numerals that would collide with their neighbours', () => {
    expect(validateRingGeometry({ ...base, thickness: 4 }, { heightFraction: 1.4 })).toContainEqual(
      expect.stringContaining('overlap'),
    );
  });
});
