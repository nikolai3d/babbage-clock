import { describe, expect, it } from 'vitest';
import { scoreFor } from './recipes.js';

const tick = { kind: 'tick', durationMs: 190, carryDepth: 0 } as const;

describe('scoreFor', () => {
  it('keeps a correction silent', () => {
    expect(scoreFor({ kind: 'seek', durationMs: 1100, carryDepth: 6 })).toEqual([]);
  });

  it('lands every sound at the travel end, where the drum seats', () => {
    for (const sound of scoreFor(tick)) {
      expect(sound.atMs).toBeGreaterThanOrEqual(tick.durationMs);
    }
  });

  it('gives a plain tick a click and a faint ring, nothing heavy', () => {
    const score = scoreFor(tick);
    expect(score).toHaveLength(2);
    expect(score.filter((sound) => sound.kind === 'noise')).toHaveLength(1);
  });

  it('weights a cascade as one heavier event, not many clicks', () => {
    const shallow = scoreFor({ kind: 'tick', durationMs: 216, carryDepth: 1 });
    const deep = scoreFor({ kind: 'tick', durationMs: 300, carryDepth: 6 });
    // One thunk each — depth changes weight, never count.
    expect(shallow).toHaveLength(3);
    expect(deep).toHaveLength(3);
    const thunk = (score: typeof shallow) =>
      score.find((sound) => sound.kind === 'noise' && sound.frequency < 1000)!;
    expect(thunk(deep).gain).toBeGreaterThan(thunk(shallow).gain);
    expect(thunk(deep).gain).toBeLessThanOrEqual(1);
  });

  it('strikes an inharmonic bell at expiry, after the final tick', () => {
    const score = scoreFor({ kind: 'expire', durationMs: 190, carryDepth: 0 });
    const bell = score.filter((sound) => sound.atMs > 190);
    expect(bell.length).toBeGreaterThanOrEqual(4);
    const ratios = bell.map((partial) => partial.frequency / bell[0]!.frequency);
    // Not a harmonic series: the second partial is deliberately off 3.
    expect(Math.abs(ratios[1]! - Math.round(ratios[1]!))).toBeGreaterThan(0.1);
  });

  it('varies pitch deterministically by seed', () => {
    const a = scoreFor(tick, 1);
    const b = scoreFor(tick, 2);
    const again = scoreFor(tick, 1);
    expect(a[0]!.frequency).not.toBe(b[0]!.frequency);
    expect(a).toEqual(again);
  });
});
