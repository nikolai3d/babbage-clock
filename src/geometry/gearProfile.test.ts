import { describe, expect, it } from 'vitest';
import {
  gearOutline,
  gearToothProfile,
  resolveBodyRadii,
  spokeCountFor,
  validateGearParams,
  type GearSpokeStyle,
} from './gearProfile.js';
import { signedArea, type Contour } from './types.js';

const TWO_PI = Math.PI * 2;

/** Polar angle of every point, unwrapped so it runs monotonically if the contour is star-shaped. */
function angleDeltas(contour: Contour): number[] {
  const deltas: number[] = [];
  for (let i = 0; i < contour.length; i += 1) {
    const a = contour[i]!;
    const b = contour[(i + 1) % contour.length]!;
    let delta = Math.atan2(b.y, b.x) - Math.atan2(a.y, a.x);
    while (delta <= -Math.PI) delta += TWO_PI;
    while (delta > Math.PI) delta -= TWO_PI;
    deltas.push(delta);
  }
  return deltas;
}

describe('gearToothProfile', () => {
  const cases = [
    { teeth: 8, radius: 0.3 },
    { teeth: 10, radius: 0.34, pressureAngleDeg: 14.5 },
    { teeth: 13, radius: 0.44 },
    { teeth: 24, radius: 0.8, addendumFactor: 1.4 },
    { teeth: 60, radius: 2, dedendumFactor: 1.6 },
    { teeth: 120, radius: 1 },
  ];

  it.each(cases)('winds strictly counter-clockwise for $teeth teeth', (params) => {
    const contour = gearToothProfile(params);
    const deltas = angleDeltas(contour);

    // No step ever goes backwards, and none jumps a whole tooth: together these
    // mean the contour is star-shaped about the centre, so it cannot
    // self-intersect. Zero-length steps are the purely radial drop from the
    // flank down to the root circle, which is a legitimate vertical edge.
    for (let i = 0; i < deltas.length; i += 1) {
      expect(deltas[i]!).toBeGreaterThan(-1e-12);
      expect(deltas[i]!).toBeLessThan(TWO_PI / params.teeth);
      if (Math.abs(deltas[i]!) < 1e-12) {
        const a = contour[i]!;
        const b = contour[(i + 1) % contour.length]!;
        expect(Math.hypot(a.x, a.y)).not.toBeCloseTo(Math.hypot(b.x, b.y), 9);
      }
    }
    expect(deltas.reduce((sum, d) => sum + d, 0)).toBeCloseTo(TWO_PI, 6);
    expect(signedArea(contour)).toBeGreaterThan(0);
  });

  it.each(cases)('keeps every point between root and tip for $teeth teeth', (params) => {
    const radii = gearToothProfile(params).map((p) => Math.hypot(p.x, p.y));
    const min = Math.min(...radii);
    const max = Math.max(...radii);

    expect(min).toBeGreaterThan(0);
    expect(min).toBeLessThan(params.radius);
    expect(max).toBeGreaterThan(params.radius);
    // The tooth-height clamp keeps low tooth counts from growing flower petals.
    expect(max).toBeLessThanOrEqual(params.radius * 1.11);
  });

  it('produces two points per tooth on the pitch circle side of every flank', () => {
    const contour = gearToothProfile({ teeth: 12, radius: 1, flankSegments: 4 });
    // 2 root drops + 2 * (flankSegments + 1) flank + (tipSegments - 1) tip +
    // (rootSegments - 1) root, per tooth.
    expect(contour.length).toBe(12 * (2 + 10 + 1 + 2));
  });

  it('rounds a fractional tooth count rather than producing a partial tooth', () => {
    const contour = gearToothProfile({ teeth: 11.4, radius: 1 });
    const deltas = angleDeltas(contour);
    expect(deltas.reduce((sum, d) => sum + d, 0)).toBeCloseTo(TWO_PI, 6);
  });
});

describe('gearOutline', () => {
  const styles: GearSpokeStyle[] = ['solid', 'spoke5', 'spoke6', 'crescent'];

  it.each(styles)('puts every %s cutout inside the rim and outside the hub', (spokeStyle) => {
    const params = { teeth: 18, radius: 0.62, spokeStyle };
    const outline = gearOutline(params);
    const body = resolveBodyRadii(params);

    // The bore is the first hole; the rest are spoke or crescent cutouts.
    const cutouts = body.boreRadius > 0 ? outline.holes.slice(1) : outline.holes;
    expect(cutouts).toHaveLength(spokeCountFor(spokeStyle));

    for (const cutout of cutouts) {
      for (const point of cutout) {
        const r = Math.hypot(point.x, point.y);
        expect(r).toBeGreaterThanOrEqual(body.hubRadius - 1e-9);
        expect(r).toBeLessThanOrEqual(body.rimInnerRadius + 1e-9);
      }
    }
  });

  it('winds holes opposite to the outer contour', () => {
    const outline = gearOutline({ teeth: 20, radius: 1, spokeStyle: 'spoke6' });
    expect(signedArea(outline.contour)).toBeGreaterThan(0);
    for (const hole of outline.holes) expect(signedArea(hole)).toBeLessThan(0);
  });

  it('drops cutouts when the web is too narrow for them', () => {
    const outline = gearOutline({
      teeth: 20,
      radius: 1,
      spokeStyle: 'spoke6',
      hubRadius: 0.82,
      rimInnerRadius: 0.85,
      spokeWidth: 0.3,
    });
    expect(outline.holes).toHaveLength(1); // bore only
  });

  it('omits the bore when asked for a solid centre', () => {
    const outline = gearOutline({ teeth: 20, radius: 1, boreRadius: 0, spokeStyle: 'solid' });
    expect(outline.holes).toHaveLength(0);
  });

  it('throws rather than emitting geometry it knows is broken', () => {
    expect(() => gearOutline({ teeth: 2, radius: 1 })).toThrow(/at least 3 teeth/);
  });
});

describe('validateGearParams', () => {
  it('accepts the wheels the shipped scenes ask for', () => {
    for (const teeth of [10, 13, 15, 18, 24]) {
      expect(validateGearParams({ teeth, radius: 0.5, spokeStyle: 'spoke5' })).toEqual([]);
    }
  });

  it('reports every problem at once', () => {
    const errors = validateGearParams({ teeth: 1, radius: -1, pressureAngleDeg: 80 });
    expect(errors.length).toBeGreaterThanOrEqual(3);
  });

  it('rejects a bore that would swallow the teeth', () => {
    expect(validateGearParams({ teeth: 20, radius: 1, boreRadius: 0.99 })).toContainEqual(
      expect.stringContaining('bore'),
    );
  });

  it('rejects a hub inside its own bore', () => {
    expect(
      validateGearParams({ teeth: 20, radius: 1, boreRadius: 0.3, hubRadius: 0.2 }),
    ).toContainEqual(expect.stringContaining('hub'));
  });
});
