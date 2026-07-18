import { describe, expect, it } from 'vitest';
import { clockDigitsZoned, clockParts, formatClock } from './clock.js';

/** 2026-06-15T12:34:56Z. */
const NOON_ISH = Date.UTC(2026, 5, 15, 12, 34, 56);

describe('clockParts', () => {
  it('reads the wall clock in the requested zone', () => {
    expect(clockParts(NOON_ISH, { zone: 'UTC' })).toMatchObject({
      hours: 12,
      minutes: 34,
      seconds: 56,
      zone: 'UTC',
    });
    // Tokyo is UTC+9, no DST to worry about.
    expect(clockParts(NOON_ISH, { zone: 'Asia/Tokyo' }).hours).toBe(21);
  });

  it('folds to 1-12 with a meridiem in 12-hour form', () => {
    expect(clockParts(NOON_ISH, { zone: 'UTC', hours12: true })).toMatchObject({
      hours: 12,
      meridiem: 'PM',
    });
    const morning = Date.UTC(2026, 5, 15, 0, 5, 0);
    expect(clockParts(morning, { zone: 'UTC', hours12: true })).toMatchObject({
      hours: 12,
      meridiem: 'AM',
    });
    const nine = Date.UTC(2026, 5, 15, 21, 0, 0);
    expect(clockParts(nine, { zone: 'UTC', hours12: true })).toMatchObject({
      hours: 9,
      meridiem: 'PM',
    });
  });

  it('tolerates a fractional epoch, which Temporal itself would not', () => {
    expect(() => clockParts(NOON_ISH + 0.25, { zone: 'UTC' })).not.toThrow();
  });
});

describe('clockDigitsZoned', () => {
  it('packs HHMMSS onto six rings', () => {
    expect(clockDigitsZoned(NOON_ISH, 6, { zone: 'UTC' })).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it('zero-pads a seventh ring on the left', () => {
    expect(clockDigitsZoned(NOON_ISH, 7, { zone: 'UTC' })).toEqual([0, 1, 2, 3, 4, 5, 6]);
  });

  it('drops seconds first when rings are scarce', () => {
    expect(clockDigitsZoned(NOON_ISH, 4, { zone: 'UTC' })).toEqual([1, 2, 3, 4]);
  });
});

describe('formatClock', () => {
  it('pads the 24-hour form and not the 12-hour hours', () => {
    expect(formatClock(clockParts(Date.UTC(2026, 5, 15, 7, 5, 9), { zone: 'UTC' }))).toBe(
      '07:05:09',
    );
    expect(
      formatClock(clockParts(Date.UTC(2026, 5, 15, 7, 5, 9), { zone: 'UTC', hours12: true })),
    ).toBe('7:05:09 AM');
  });
});
