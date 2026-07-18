import { describe, expect, it } from 'vitest';
import { describeTimeStatus, formatDuration } from './statusText.js';
import type { TrueTimeStatus } from '../time/trueTime.js';

function status(overrides: Partial<TrueTimeStatus> = {}): TrueTimeStatus {
  return {
    tier: 'ntp-lite',
    sourceId: 'timeapi.io',
    offsetMs: 12,
    uncertaintyMs: 30,
    lastSyncMs: 1_700_000_000_000,
    sampleCount: 5,
    synced: true,
    skewWarning: false,
    degraded: false,
    ...overrides,
  };
}

describe('describeTimeStatus', () => {
  it('stays quiet when synced over ntp-lite', () => {
    const description = describeTimeStatus(status());
    expect(description).toMatchObject({ level: 'ok', quiet: true });
    expect(description.detail).toContain('timeapi.io');
  });

  it('mentions the one-second resolution of an HTTP Date sync', () => {
    const description = describeTimeStatus(status({ tier: 'http-date' }));
    expect(description.level).toBe('info');
    expect(description.text).toBe('Accurate to about a second');
  });

  it('says so when running on the device clock', () => {
    const description = describeTimeStatus(
      status({ tier: 'device-clock', degraded: true, synced: false }),
    );
    expect(description).toMatchObject({ level: 'warn', quiet: false });
    expect(description.text).toContain('Device clock');
  });

  it('does not cry "device clock" while the first sync is still in flight', () => {
    const description = describeTimeStatus(
      status({ tier: 'device-clock', degraded: true, synced: false }),
      { syncPending: true },
    );
    expect(description).toMatchObject({ level: 'info', quiet: true });
    expect(description.text).toBe('Checking world time');
  });

  it('names the direction and size of a clock skew', () => {
    // Negative offset means true time is behind the device: the device is fast.
    const fast = describeTimeStatus(status({ skewWarning: true, offsetMs: -12_000 }));
    expect(fast.text).toBe('Device clock is 12 s fast');
    expect(fast.level).toBe('warn');

    const slow = describeTimeStatus(status({ skewWarning: true, offsetMs: 90_000 }));
    expect(slow.text).toBe('Device clock is 2 min slow');
  });

  it('prefers the skew warning over the pending state', () => {
    const description = describeTimeStatus(status({ skewWarning: true, offsetMs: -8_000 }), {
      syncPending: true,
    });
    expect(description.level).toBe('warn');
  });
});

describe('formatDuration', () => {
  it('scales the unit to the magnitude', () => {
    expect(formatDuration(420)).toBe('420 ms');
    expect(formatDuration(-12_000)).toBe('12 s');
    expect(formatDuration(240_000)).toBe('4 min');
    expect(formatDuration(9_000_000)).toBe('2.5 h');
  });

  it('does not pretend to know an infinite uncertainty', () => {
    expect(formatDuration(Number.POSITIVE_INFINITY)).toBe('unknown');
  });
});
