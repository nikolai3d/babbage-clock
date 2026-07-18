import { describe, expect, it } from 'vitest';
import {
  TargetError,
  defaultTarget,
  isValidTimeZone,
  nextNewYear,
  parseTargetParam,
  resolveCountdownTarget,
  resolveTarget,
  resolveTargetFromParams,
  systemTimeSource,
} from './target.js';

/** 2026-07-01T12:00:00Z — a fixed "now" so nothing here depends on the wall clock. */
const NOW = Date.UTC(2026, 6, 1, 12, 0, 0);

describe('resolveTarget', () => {
  it('resolves a wall clock in an explicit IANA zone to the right instant', () => {
    const target = resolveTarget({
      value: '2026-12-31T23:59:59',
      zone: 'Europe/Paris',
      nowMs: NOW,
      viewerZone: 'UTC',
    });

    // Paris is UTC+1 on 31 December.
    expect(target.atMs).toBe(Date.UTC(2026, 11, 31, 22, 59, 59));
    expect(target.enteredZone.offset).toBe('+01:00');
    expect(target.disambiguation).toBe('none');
    expect(target.expired).toBe(false);
  });

  it('echoes the instant in both the entered zone and the viewer zone', () => {
    const target = resolveTarget({
      value: '2027-01-01T00:00:00',
      zone: 'Asia/Tokyo',
      nowMs: NOW,
      viewerZone: 'America/New_York',
    });

    expect(target.enteredZone.formatted).toBe('2027-01-01 00:00:00 +09:00 (Asia/Tokyo)');
    expect(target.viewerZone.formatted).toBe('2026-12-31 10:00:00 -05:00 (America/New_York)');
    expect(target.zone).toBe('Asia/Tokyo');
  });

  it('pins the instant regardless of where the viewer is', () => {
    const inputs = { value: '2026-12-31T23:59:59', zone: 'Europe/Paris', nowMs: NOW };

    const fromTokyo = resolveTarget({ ...inputs, viewerZone: 'Asia/Tokyo' });
    const fromDenver = resolveTarget({ ...inputs, viewerZone: 'America/Denver' });

    expect(fromTokyo.atMs).toBe(fromDenver.atMs);
    // Same instant, different local readings.
    expect(fromTokyo.viewerZone.wallClock).not.toBe(fromDenver.viewerZone.wallClock);
  });

  it('treats a value carrying an offset as an absolute instant', () => {
    const target = resolveTarget({ value: '2026-12-31T23:59:59Z', nowMs: NOW, viewerZone: 'UTC' });
    expect(target.atMs).toBe(Date.UTC(2026, 11, 31, 23, 59, 59));

    const offset = resolveTarget({
      value: '2026-12-31T23:59:59+05:30',
      nowMs: NOW,
      viewerZone: 'UTC',
    });
    expect(offset.atMs).toBe(Date.UTC(2026, 11, 31, 18, 29, 59));
  });

  it('does not let ?tz= move an instant that already has an offset', () => {
    const target = resolveTarget({
      value: '2026-12-31T23:59:59Z',
      zone: 'Asia/Tokyo',
      nowMs: NOW,
      viewerZone: 'UTC',
    });

    expect(target.atMs).toBe(Date.UTC(2026, 11, 31, 23, 59, 59));
    expect(target.enteredZone.zone).toBe('Asia/Tokyo');
    expect(target.notes.join(' ')).toContain('only for display');
  });

  it('accepts fixed UTC offsets as the zone', () => {
    const target = resolveTarget({
      value: '2026-12-31T12:00:00',
      zone: '+05:30',
      nowMs: NOW,
      viewerZone: 'UTC',
    });

    expect(target.atMs).toBe(Date.UTC(2026, 11, 31, 6, 30, 0));
    expect(target.enteredZone.offset).toBe('+05:30');
  });

  it('accepts date-only and space-separated values', () => {
    expect(
      resolveTarget({ value: '2026-12-31', zone: 'UTC', nowMs: NOW, viewerZone: 'UTC' }).atMs,
    ).toBe(Date.UTC(2026, 11, 31, 0, 0, 0));
    expect(
      resolveTarget({ value: '2026-12-31 18:30', zone: 'UTC', nowMs: NOW, viewerZone: 'UTC' }).atMs,
    ).toBe(Date.UTC(2026, 11, 31, 18, 30, 0));
  });

  it('accepts a bracketed zoned string and takes its zone from the string', () => {
    const target = resolveTarget({
      value: '2026-12-31T23:59:59+01:00[Europe/Paris]',
      nowMs: NOW,
      viewerZone: 'UTC',
    });

    expect(target.zone).toBe('Europe/Paris');
    expect(target.atMs).toBe(Date.UTC(2026, 11, 31, 22, 59, 59));
  });

  it('rejects unparseable values and unknown zones', () => {
    expect(() => resolveTarget({ value: 'not a date', nowMs: NOW })).toThrow(TargetError);
    expect(() => resolveTarget({ value: '', nowMs: NOW })).toThrow(TargetError);
    expect(() =>
      resolveTarget({ value: '2026-12-31T00:00:00', zone: 'Mars/Olympus', nowMs: NOW }),
    ).toThrow(TargetError);

    try {
      resolveTarget({ value: '2026-12-31T00:00:00', zone: 'Mars/Olympus', nowMs: NOW });
      expect.unreachable('should have thrown');
    } catch (error) {
      expect((error as TargetError).code).toBe('invalid-zone');
    }
  });

  it('flags a target that has already passed rather than throwing', () => {
    const target = resolveTarget({
      value: '2020-01-01T00:00:00',
      zone: 'UTC',
      nowMs: NOW,
      viewerZone: 'UTC',
    });

    expect(target.expired).toBe(true);
    expect(target.notes.join(' ')).toContain('in the past');
  });
});

describe('DST edge cases', () => {
  // 8 March 2026, US spring forward: 02:00 EST jumps straight to 03:00 EDT, so
  // nothing between 02:00 and 03:00 exists in America/New_York that day.
  it('moves a nonexistent spring-forward time forward and says so', () => {
    const target = resolveTarget({
      value: '2026-03-08T02:30:00',
      zone: 'America/New_York',
      nowMs: NOW,
      viewerZone: 'UTC',
    });

    expect(target.disambiguation).toBe('gap-forward');
    expect(target.requestedWallClock).toBe('2026-03-08T02:30:00');
    expect(target.enteredZone.wallClock).toBe('2026-03-08T03:30:00');
    expect(target.enteredZone.offset).toBe('-04:00');
    // 03:30 EDT is 07:30 UTC.
    expect(target.atMs).toBe(Date.UTC(2026, 2, 8, 7, 30, 0));
    expect(target.notes.join(' ')).toContain('does not exist');
  });

  it('handles the European spring-forward gap too', () => {
    // 29 March 2026, 01:00 UTC: 02:00 CET becomes 03:00 CEST in Europe/Paris.
    const target = resolveTarget({
      value: '2026-03-29T02:30:00',
      zone: 'Europe/Paris',
      nowMs: NOW,
      viewerZone: 'UTC',
    });

    expect(target.disambiguation).toBe('gap-forward');
    expect(target.enteredZone.wallClock).toBe('2026-03-29T03:30:00');
    expect(target.atMs).toBe(Date.UTC(2026, 2, 29, 1, 30, 0));
  });

  // 1 November 2026, US fall back: 02:00 EDT returns to 01:00 EST, so 01:30
  // happens twice — once at -04:00 and again an hour later at -05:00.
  it('picks the earlier instant for an ambiguous fall-back time and says so', () => {
    const target = resolveTarget({
      value: '2026-11-01T01:30:00',
      zone: 'America/New_York',
      nowMs: NOW,
      viewerZone: 'UTC',
    });

    expect(target.disambiguation).toBe('ambiguous-earlier');
    expect(target.enteredZone.wallClock).toBe('2026-11-01T01:30:00');
    expect(target.enteredZone.offset).toBe('-04:00');
    // The earlier of the two: 05:30 UTC, not 06:30 UTC.
    expect(target.atMs).toBe(Date.UTC(2026, 10, 1, 5, 30, 0));
    expect(target.notes.join(' ')).toContain('happens twice');
  });

  it('leaves an unambiguous time alone', () => {
    const target = resolveTarget({
      value: '2026-11-01T04:30:00',
      zone: 'America/New_York',
      nowMs: NOW,
      viewerZone: 'UTC',
    });

    expect(target.disambiguation).toBe('none');
    expect(target.requestedWallClock).toBeNull();
    expect(target.notes).toEqual([]);
  });

  it('applies the viewer zone offset in force at the instant, not today’s', () => {
    // Tokyo has no DST; New York changes at 06:00 UTC on 1 November 2026.
    // 12:00 Tokyo is 03:00 UTC — still EDT (-04:00), an hour before the switch.
    const beforeSwitch = resolveTarget({
      value: '2026-11-01T12:00:00',
      zone: 'Asia/Tokyo',
      nowMs: NOW,
      viewerZone: 'America/New_York',
    });
    expect(beforeSwitch.viewerZone.offset).toBe('-04:00');
    expect(beforeSwitch.viewerZone.wallClock).toBe('2026-10-31T23:00:00');

    // 18:00 Tokyo is 09:00 UTC — after the switch, so EST (-05:00).
    const afterSwitch = resolveTarget({
      value: '2026-11-01T18:00:00',
      zone: 'Asia/Tokyo',
      nowMs: NOW,
      viewerZone: 'America/New_York',
    });
    expect(afterSwitch.viewerZone.offset).toBe('-05:00');
    expect(afterSwitch.viewerZone.wallClock).toBe('2026-11-01T04:00:00');
  });
});

describe('resolveTargetFromParams', () => {
  it('reads ?target= and ?tz= together', () => {
    const target = resolveTargetFromParams(
      { target: '2026-12-31T23:59:59', tz: 'Europe/Paris' },
      NOW,
      'UTC',
    );

    expect(target.source).toBe('url');
    expect(target.atMs).toBe(Date.UTC(2026, 11, 31, 22, 59, 59));
  });

  it('interprets a zone-less ?target= in the viewer zone', () => {
    const target = resolveTargetFromParams({ target: '2026-12-31T23:59:59' }, NOW, 'Asia/Tokyo');

    expect(target.zone).toBe('Asia/Tokyo');
    expect(target.atMs).toBe(Date.UTC(2026, 11, 31, 14, 59, 59));
  });

  it('falls back to the next New Year when ?target= is absent', () => {
    const target = resolveTargetFromParams({ target: null }, NOW, 'UTC');

    expect(target.source).toBe('default-new-year');
    expect(target.label).toBe('New Year 2027');
    expect(target.atMs).toBe(Date.UTC(2027, 0, 1, 0, 0, 0));
  });

  it('falls back with an explanation rather than throwing on bad input', () => {
    const target = resolveTargetFromParams({ target: 'yesterday-ish', tz: null }, NOW, 'UTC');

    expect(target.source).toBe('default-new-year');
    expect(target.notes[0]).toContain('Ignored ?target=yesterday-ish');
  });

  it('falls back when the zone is unknown', () => {
    const target = resolveTargetFromParams(
      { target: '2026-12-31T23:59:59', tz: 'Mars/Olympus' },
      NOW,
      'UTC',
    );

    expect(target.source).toBe('default-new-year');
    expect(target.notes[0]).toContain('Mars/Olympus');
  });
});

describe('defaultTarget', () => {
  it('is the next New Year in the viewer zone and is always in the future', () => {
    const target = defaultTarget(NOW, 'Asia/Tokyo');

    expect(target.atMs).toBe(Date.UTC(2026, 11, 31, 15, 0, 0));
    expect(target.atMs).toBeGreaterThan(NOW);
    expect(target.expired).toBe(false);
  });

  it('still points a year ahead on New Year’s Day', () => {
    const newYearsDay = Date.UTC(2027, 0, 1, 0, 0, 1);
    const target = defaultTarget(newYearsDay, 'UTC');

    expect(target.label).toBe('New Year 2028');
    expect(target.atMs).toBe(Date.UTC(2028, 0, 1, 0, 0, 0));
  });
});

describe('scaffold compatibility', () => {
  it('keeps the TimeSource shape', () => {
    expect(typeof systemTimeSource.now()).toBe('number');
    const fake = { now: () => 42 };
    const asSource: { now(): number } = fake;
    expect(asSource.now()).toBe(42);
  });

  it('keeps nextNewYear returning a Date in the future', () => {
    const date = nextNewYear(NOW);
    expect(date).toBeInstanceOf(Date);
    expect(date.getTime()).toBeGreaterThan(NOW);
  });

  it('keeps parseTargetParam null-safe', () => {
    expect(parseTargetParam(null)).toBeNull();
    expect(parseTargetParam('   ')).toBeNull();
    expect(parseTargetParam('nonsense')).toBeNull();
    expect(parseTargetParam('2026-12-31T23:59:59Z')?.getTime()).toBe(
      Date.UTC(2026, 11, 31, 23, 59, 59),
    );
  });

  it('keeps resolveCountdownTarget working with two arguments', () => {
    const fromUrl = resolveCountdownTarget('2026-12-31T23:59:59Z', NOW);
    expect(fromUrl.source).toBe('url');
    expect(fromUrl.atMs).toBe(Date.UTC(2026, 11, 31, 23, 59, 59));

    expect(resolveCountdownTarget(null, NOW).source).toBe('default-new-year');
  });
});

describe('isValidTimeZone', () => {
  it('accepts IANA ids, offsets and local aliases', () => {
    expect(isValidTimeZone('America/New_York')).toBe(true);
    expect(isValidTimeZone('UTC')).toBe(true);
    expect(isValidTimeZone('+05:30')).toBe(true);
    expect(isValidTimeZone('local')).toBe(true);
    expect(isValidTimeZone(undefined)).toBe(true);
  });

  it('rejects nonsense', () => {
    expect(isValidTimeZone('Mars/Olympus')).toBe(false);
    expect(isValidTimeZone('+99:99')).toBe(false);
  });
});
