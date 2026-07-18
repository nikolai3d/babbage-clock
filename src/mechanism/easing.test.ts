import { describe, expect, it } from 'vitest';
import {
  clamp01,
  easeInOutCubic,
  escapementEase,
  pulseEnvelope,
  DEFAULT_OVERSHOOT,
} from './easing.js';

/**
 * These assertions are the definition of "the tick looks mechanical, not like a
 * slide". Everything the eye reads as an escapement release — the dead moment
 * while the detent lifts, the swing past the notch, the settle — is a property
 * of this curve, so it is pinned here rather than eyeballed in a browser.
 */
describe('escapementEase', () => {
  const sample = (steps = 400): { t: number; value: number }[] =>
    Array.from({ length: steps + 1 }, (_, i) => {
      const t = i / steps;
      return { t, value: escapementEase(t) };
    });

  it('starts at rest and ends exactly on the digit', () => {
    expect(escapementEase(0)).toBe(0);
    expect(escapementEase(1)).toBeCloseTo(1, 12);
  });

  it('leaves no residual offset, so ticks cannot accumulate error', () => {
    // 3,600 ticks of a leftover 1e-6 rad would be a visibly crooked ring.
    for (const overshoot of [0, 0.05, DEFAULT_OVERSHOOT, 0.4]) {
      expect(escapementEase(1, overshoot)).toBeCloseTo(1, 12);
    }
  });

  it('barely moves while the detent is lifting', () => {
    // A slide covers 15% of the distance in the first 15% of the time. The
    // release covers a fraction of that, which is the pause the eye reads as
    // the lock letting go.
    expect(escapementEase(0.15)).toBeLessThan(0.15 / 2);
    expect(escapementEase(0.08)).toBeLessThan(0.08 / 4);
  });

  it('overshoots the notch and comes back — the part that reads as mechanical', () => {
    const values = sample().map((entry) => entry.value);
    const peak = Math.max(...values);

    expect(peak).toBeGreaterThan(1);
    expect(peak).toBeCloseTo(1 + DEFAULT_OVERSHOOT, 2);

    // Non-monotonic: it comes back under the peak. A slide never does.
    const peakIndex = values.indexOf(peak);
    expect(peakIndex).toBeGreaterThan(0);
    expect(Math.min(...values.slice(peakIndex))).toBeLessThan(1);
  });

  it('is fastest in the middle of the release, not at the ends', () => {
    const entries = sample(200);
    const speeds = entries.slice(1).map((entry, i) => entry.value - entries[i]!.value);
    const fastest = speeds.indexOf(Math.max(...speeds)) / speeds.length;

    expect(fastest).toBeGreaterThan(0.2);
    expect(fastest).toBeLessThan(0.55);
  });

  it('scales its overshoot, and a zero overshoot is a plain ease', () => {
    const flat = Array.from({ length: 101 }, (_, i) => escapementEase(i / 100, 0));
    expect(Math.max(...flat)).toBeCloseTo(1, 6);
    expect(
      Math.max(...Array.from({ length: 101 }, (_, i) => escapementEase(i / 100, 0.3))),
    ).toBeGreaterThan(1.25);
  });

  it('clamps outside the unit interval', () => {
    expect(escapementEase(-5)).toBe(0);
    expect(escapementEase(5)).toBeCloseTo(1, 12);
  });
});

describe('easeInOutCubic', () => {
  it('is monotonic and hits both ends exactly', () => {
    expect(easeInOutCubic(0)).toBe(0);
    expect(easeInOutCubic(1)).toBe(1);
    expect(easeInOutCubic(0.5)).toBeCloseTo(0.5, 12);

    let previous = -1;
    for (let i = 0; i <= 100; i += 1) {
      const value = easeInOutCubic(i / 100);
      expect(value).toBeGreaterThanOrEqual(previous);
      previous = value;
    }
  });

  it('never overshoots — a correction must not look like a tick', () => {
    for (let i = 0; i <= 100; i += 1) expect(easeInOutCubic(i / 100)).toBeLessThanOrEqual(1);
  });
});

describe('pulseEnvelope', () => {
  it('lifts and reseats', () => {
    expect(pulseEnvelope(0)).toBeCloseTo(0, 12);
    expect(pulseEnvelope(0.5)).toBeCloseTo(1, 12);
    expect(pulseEnvelope(1)).toBeCloseTo(0, 12);
  });
});

describe('clamp01', () => {
  it('clamps, and treats NaN as finished rather than as a stuck animation', () => {
    expect(clamp01(-1)).toBe(0);
    expect(clamp01(0.25)).toBe(0.25);
    expect(clamp01(2)).toBe(1);
    expect(clamp01(Number.NaN)).toBe(1);
  });
});
