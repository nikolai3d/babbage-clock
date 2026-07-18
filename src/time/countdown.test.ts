import { describe, expect, it } from 'vitest';
import {
  MS_PER_DAY,
  MS_PER_HOUR,
  MS_PER_MINUTE,
  MS_PER_SECOND,
  clockDigits,
  computeCountdown,
  countdownDigits,
  formatCountdown,
} from './countdown.js';
import { nextNewYear, parseTargetParam, resolveCountdownTarget } from './target.js';

describe('computeCountdown', () => {
  it('splits a future interval into components', () => {
    const now = 0;
    const target = 3 * MS_PER_DAY + 4 * MS_PER_HOUR + 5 * MS_PER_MINUTE + 6 * MS_PER_SECOND + 7;

    const parts = computeCountdown(target, now);

    expect(parts.elapsed).toBe(false);
    expect(parts).toMatchObject({ days: 3, hours: 4, minutes: 5, seconds: 6, milliseconds: 7 });
  });

  it('reports elapsed time with non-negative components once the target passes', () => {
    const parts = computeCountdown(0, 90 * MS_PER_MINUTE);

    expect(parts.elapsed).toBe(true);
    expect(parts.totalMs).toBeLessThan(0);
    expect(parts).toMatchObject({ days: 0, hours: 1, minutes: 30, seconds: 0 });
  });

  it('is all zeroes exactly on the target', () => {
    const parts = computeCountdown(1_000, 1_000);

    expect(parts.elapsed).toBe(false);
    expect(parts).toMatchObject({ days: 0, hours: 0, minutes: 0, seconds: 0, milliseconds: 0 });
  });
});

describe('formatCountdown', () => {
  it('pads components and omits a zero day count', () => {
    expect(formatCountdown(computeCountdown(9 * MS_PER_MINUTE + 5 * MS_PER_SECOND, 0))).toBe(
      '00:09:05',
    );
  });

  it('shows days and marks elapsed targets', () => {
    expect(formatCountdown(computeCountdown(0, 2 * MS_PER_DAY))).toBe('+2d 00:00:00');
  });
});

describe('countdownDigits', () => {
  it('fills the ring count least-significant-first', () => {
    const parts = computeCountdown(
      12 * MS_PER_DAY + 3 * MS_PER_HOUR + 45 * MS_PER_MINUTE + 6 * MS_PER_SECOND,
      0,
    );

    // "12" + "03" + "45" + "06"
    expect(countdownDigits(parts, 8)).toEqual([1, 2, 0, 3, 4, 5, 0, 6]);
  });

  it('zero-pads on the left when there are more rings than digits', () => {
    const parts = computeCountdown(7 * MS_PER_SECOND, 0);

    expect(countdownDigits(parts, 7)).toEqual([0, 0, 0, 0, 0, 0, 7]);
  });

  it('keeps the least significant digits when rings are scarce', () => {
    const parts = computeCountdown(
      99 * MS_PER_DAY + 11 * MS_PER_HOUR + 22 * MS_PER_MINUTE + 33 * MS_PER_SECOND,
      0,
    );

    expect(countdownDigits(parts, 4)).toEqual([2, 2, 3, 3]);
  });

  it('returns an empty array for a non-positive ring count', () => {
    expect(countdownDigits(computeCountdown(0, 0), 0)).toEqual([]);
  });

  it('never yields a value outside 0-9', () => {
    const parts = computeCountdown(1234 * MS_PER_DAY + 23 * MS_PER_HOUR, 0);

    for (const digit of countdownDigits(parts, 7)) {
      expect(digit).toBeGreaterThanOrEqual(0);
      expect(digit).toBeLessThanOrEqual(9);
    }
  });
});

describe('clockDigits', () => {
  it('reads HHMMSS across six rings', () => {
    const date = new Date(2026, 0, 2, 13, 4, 5);

    expect(clockDigits(date, 6)).toEqual([1, 3, 0, 4, 0, 5]);
  });

  it('drops the least significant digits when rings are scarce', () => {
    const date = new Date(2026, 0, 2, 13, 4, 5);

    expect(clockDigits(date, 4)).toEqual([1, 3, 0, 4]);
  });
});

describe('countdown targets', () => {
  it('defaults to the next New Year in the viewer timezone', () => {
    const now = new Date(2026, 5, 15, 12, 0, 0).getTime();
    const target = nextNewYear(now);

    expect(target.getFullYear()).toBe(2027);
    expect(target.getMonth()).toBe(0);
    expect(target.getDate()).toBe(1);
    expect(target.getHours()).toBe(0);
    expect(target.getTime()).toBeGreaterThan(now);
  });

  it('stays in the future on New Year morning itself', () => {
    const now = new Date(2026, 0, 1, 0, 0, 0).getTime();

    expect(nextNewYear(now).getTime()).toBeGreaterThan(now);
  });

  it('parses an ISO target and reports it as URL-sourced', () => {
    const resolved = resolveCountdownTarget('2030-03-04T05:06:07Z', 0);

    expect(resolved.source).toBe('url');
    expect(resolved.atMs).toBe(Date.UTC(2030, 2, 4, 5, 6, 7));
  });

  it('falls back to the default target for unparseable input', () => {
    expect(parseTargetParam('not-a-date')).toBeNull();
    expect(resolveCountdownTarget('not-a-date', 0).source).toBe('default-new-year');
    expect(resolveCountdownTarget(null, 0).source).toBe('default-new-year');
  });
});
