import { describe, expect, it } from 'vitest';
import { readoutStateText } from './readoutState.js';
import { computeCountdown, computeRemaining } from '../time/countdown.js';

const NOW = Date.UTC(2026, 0, 1, 0, 0, 0);

function at(msFromNow: number) {
  const target = NOW + msFromNow;
  return {
    countdown: computeCountdown(target, NOW),
    remaining: computeRemaining(target, NOW),
  };
}

const HOUR = 3_600_000;

describe('readoutStateText', () => {
  it('says nothing for an ordinary countdown', () => {
    const { countdown, remaining } = at(5 * HOUR);
    expect(remaining.clamped).toBe(false);
    expect(readoutStateText(countdown, remaining)).toBe('');
  });

  it('explains the cap once the rings can no longer show the true value', () => {
    // 199 days is what the readout shows; the rings stop at 999 hours.
    const { countdown, remaining } = at(199 * 24 * HOUR + 12 * HOUR);
    expect(remaining.clamped).toBe(true);
    expect(readoutStateText(countdown, remaining)).toBe('rings hold at 999:59:59');
  });

  it('states the cap without the "greater than" prefix', () => {
    // The rings sit exactly on the cap, so the sentence must not read `>999`.
    const { countdown, remaining } = at(2000 * HOUR);
    expect(readoutStateText(countdown, remaining)).not.toContain('>');
  });

  it('stops explaining the cap the moment it stops applying', () => {
    const { countdown, remaining } = at(998 * HOUR);
    expect(remaining.clamped).toBe(false);
    expect(readoutStateText(countdown, remaining)).toBe('');
  });

  it('prefers expiry over the cap', () => {
    const { countdown, remaining } = at(-HOUR);
    expect(countdown.elapsed).toBe(true);
    expect(readoutStateText(countdown, remaining)).toBe('Time up');
  });
});
