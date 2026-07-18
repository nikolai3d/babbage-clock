import { describe, expect, it } from 'vitest';
import { summarizeTarget, toDateTimeLocalValue } from './targetSummary.js';
import { defaultTarget, resolveTarget } from '../time/target.js';

const NOW = Date.UTC(2026, 0, 15, 12, 0, 0);
const VIEWER = 'America/New_York';

function target(value: string, zone: string) {
  return resolveTarget({ value, zone, nowMs: NOW, viewerZone: VIEWER });
}

describe('summarizeTarget', () => {
  it('echoes both zones when they differ', () => {
    const summary = summarizeTarget(target('2027-01-01T00:00:00', 'Asia/Tokyo'));
    expect(summary.entered).toMatchObject({
      caption: 'Entered zone',
      zone: 'Asia/Tokyo',
      wallClock: '2027-01-01 00:00:00',
      offset: '+09:00',
    });
    expect(summary.viewer).toMatchObject({
      caption: 'Your zone',
      zone: VIEWER,
      wallClock: '2026-12-31 10:00:00',
    });
  });

  it('does not echo the same line twice when the zones match', () => {
    const summary = summarizeTarget(target('2026-12-31T23:59:59', VIEWER));
    expect(summary.viewer).toBeNull();
    expect(summary.entered.caption).toBe('Target');
  });

  it('tags a daylight-saving gap and keeps the timing module’s sentence', () => {
    const summary = summarizeTarget(target('2026-03-08T02:30:00', VIEWER));
    expect(summary.adjustment).toBe('Daylight-saving gap — moved forward');
    expect(summary.notes.join(' ')).toContain('does not exist');
    expect(summary.notes.join(' ')).toContain('03:30');
  });

  it('tags an ambiguous fall-back time', () => {
    const summary = summarizeTarget(target('2026-11-01T01:30:00', VIEWER));
    expect(summary.adjustment).toBe('Ambiguous time — using the earlier one');
  });

  it('has no adjustment tag in the ordinary case', () => {
    expect(summarizeTarget(target('2026-06-01T12:00:00', VIEWER)).adjustment).toBeNull();
  });

  it('reports expiry as a state, not as a note', () => {
    const summary = summarizeTarget(target('2020-01-01T00:00:00', VIEWER));
    expect(summary.expired).toBe(true);
    expect(summary.notes).not.toContain('This target is in the past.');
  });

  it('describes where the target came from', () => {
    expect(summarizeTarget(defaultTarget(NOW, VIEWER)).origin).toContain('Default');
    expect(summarizeTarget(target('2026-06-01T12:00', VIEWER)).origin).toBe('Set by you');
  });
});

describe('toDateTimeLocalValue', () => {
  it('produces the value a stepped datetime-local input expects', () => {
    expect(toDateTimeLocalValue(target('2026-06-01T12:00', VIEWER))).toBe('2026-06-01T12:00:00');
  });

  it('uses the adjusted wall clock after a gap adjustment', () => {
    expect(toDateTimeLocalValue(target('2026-03-08T02:30:00', VIEWER))).toBe('2026-03-08T03:30:00');
  });
});
