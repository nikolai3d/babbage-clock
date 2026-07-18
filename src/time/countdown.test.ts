import { describe, expect, it } from 'vitest';
import {
  MAX_DISPLAY_HOURS,
  MAX_DISPLAY_SECONDS,
  MS_PER_DAY,
  MS_PER_HOUR,
  MS_PER_MINUTE,
  MS_PER_SECOND,
  clockDigits,
  computeCountdown,
  computeRemaining,
  countdownDigits,
  formatCountdown,
  formatRemaining,
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

describe('computeRemaining', () => {
  const at = (hours: number, minutes: number, seconds: number): number =>
    hours * MS_PER_HOUR + minutes * MS_PER_MINUTE + seconds * MS_PER_SECOND;

  it('splits the interval into HHH:MM:SS', () => {
    const remaining = computeRemaining(at(12, 34, 56), 0);

    expect(remaining).toMatchObject({ hours: 12, minutes: 34, seconds: 56, clamped: false });
    expect(remaining.totalSeconds).toBe(12 * 3600 + 34 * 60 + 56);
    expect(remaining.expired).toBe(false);
  });

  it('lets hours run past 24 rather than rolling into days', () => {
    expect(computeRemaining(at(100, 0, 0), 0).hours).toBe(100);
  });

  it('floors part-seconds, so the last second is shown for its whole duration', () => {
    expect(computeRemaining(1_999, 0).seconds).toBe(1);
    expect(computeRemaining(1_000, 0).seconds).toBe(1);
    // Under a second left: the readout is zero but the target has not arrived.
    expect(computeRemaining(999, 0).seconds).toBe(0);
    expect(computeRemaining(999, 0).expired).toBe(false);
  });

  it('clamps at 999:59:59 and says that it is clamped', () => {
    const remaining = computeRemaining(at(2_000, 0, 0), 0);

    expect(remaining).toMatchObject({
      hours: MAX_DISPLAY_HOURS,
      minutes: 59,
      seconds: 59,
      clamped: true,
    });
    expect(remaining.totalSeconds).toBe(MAX_DISPLAY_SECONDS);
    // The unclamped magnitude is still available to whoever wants it.
    expect(remaining.rawTotalSeconds).toBe(2_000 * 3600);
  });

  it('unclamps exactly at the cap boundary', () => {
    const atCap = computeRemaining(MAX_DISPLAY_SECONDS * MS_PER_SECOND, 0);
    expect(atCap.clamped).toBe(false);
    expect(atCap.hours).toBe(MAX_DISPLAY_HOURS);
    expect(atCap.minutes).toBe(59);
    expect(atCap.seconds).toBe(59);

    const oneOver = computeRemaining((MAX_DISPLAY_SECONDS + 1) * MS_PER_SECOND, 0);
    expect(oneOver.clamped).toBe(true);
  });

  it('expires exactly at the target instant, not a second either side', () => {
    expect(computeRemaining(1_000, 0).expired).toBe(false);
    expect(computeRemaining(1_000, 1_000).expired).toBe(true);
    expect(computeRemaining(1_000, 999).expired).toBe(false);
  });

  it('zeroes every component once expired and keeps the raw value negative', () => {
    const remaining = computeRemaining(0, at(3, 0, 0));

    expect(remaining).toMatchObject({
      totalSeconds: 0,
      hours: 0,
      minutes: 0,
      seconds: 0,
      expired: true,
      clamped: false,
    });
    expect(remaining.rawTotalSeconds).toBe(-3 * 3600);
  });
});

describe('formatRemaining', () => {
  it('pads hours to three digits', () => {
    expect(formatRemaining(computeRemaining(9 * MS_PER_HOUR + 5 * MS_PER_MINUTE, 0))).toBe(
      '009:05:00',
    );
  });

  it('marks a clamped value as a lower bound', () => {
    expect(formatRemaining(computeRemaining(5_000 * MS_PER_HOUR, 0))).toBe('>999:59:59');
  });

  it('reads all zeroes once expired', () => {
    expect(formatRemaining(computeRemaining(0, 1_000))).toBe('000:00:00');
  });
});
