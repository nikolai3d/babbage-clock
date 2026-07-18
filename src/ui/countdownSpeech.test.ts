import { describe, expect, it } from 'vitest';
import { announcementKey, countdownAnnouncement, describeRemaining } from './countdownSpeech.js';
import { computeRemaining } from '../time/countdown.js';
import type { RemainingTime } from '../time/countdown.js';

/** A remaining time built the way the app builds it: from two instants. */
function remainingIn(seconds: number): RemainingTime {
  return computeRemaining(seconds * 1000, 0);
}

describe('describeRemaining', () => {
  it('speaks hours and minutes, not HHH:MM:SS', () => {
    expect(describeRemaining(remainingIn(41 * 3600 + 12 * 60 + 30))).toBe(
      '41 hours, 12 minutes remaining.',
    );
  });

  it('singularises', () => {
    expect(describeRemaining(remainingIn(3600 + 60))).toBe('1 hour, 1 minute remaining.');
    expect(describeRemaining(remainingIn(1))).toBe('1 second remaining.');
  });

  it('drops empty components', () => {
    expect(describeRemaining(remainingIn(3 * 3600))).toBe('3 hours remaining.');
    expect(describeRemaining(remainingIn(2 * 3600 + 30))).toBe('2 hours remaining.');
  });

  it('adds seconds only under an hour, where they matter', () => {
    expect(describeRemaining(remainingIn(90))).toBe('1 minute, 30 seconds remaining.');
    expect(describeRemaining(remainingIn(9))).toBe('9 seconds remaining.');
    expect(describeRemaining(remainingIn(120))).toBe('2 minutes remaining.');
  });

  it('says the clamp rather than a number the rings are not showing', () => {
    const clamped = remainingIn(2000 * 3600);
    expect(clamped.clamped).toBe(true);
    expect(describeRemaining(clamped)).toBe('More than 999 hours remaining.');
  });

  it('announces expiry', () => {
    expect(describeRemaining(computeRemaining(0, 1000))).toBe('Time is up.');
  });
});

describe('announcementKey', () => {
  it('changes once a minute, not once a second', () => {
    const key = announcementKey(remainingIn(600));
    // Every second of the same minute belongs to the same slot.
    expect(announcementKey(remainingIn(599))).toBe(key);
    expect(announcementKey(remainingIn(541))).toBe(key);
    // Crossing the minute boundary moves to the next one.
    expect(announcementKey(remainingIn(540))).not.toBe(key);
  });

  it('never repeats a slot across a whole hour of ticking', () => {
    const keys = new Set<string>();
    let previous = '';
    let changes = 0;
    for (let seconds = 3600; seconds >= 1; seconds -= 1) {
      const key = announcementKey(remainingIn(seconds));
      keys.add(key);
      if (key !== previous) changes += 1;
      previous = key;
    }
    // 60 minute slots plus the 60/30/10-second thresholds, and the slot only
    // ever advances — one announcement each, never a per-second stream.
    expect(keys.size).toBe(changes);
    expect(changes).toBeLessThanOrEqual(64);
    expect(changes).toBeGreaterThan(55);
  });

  it('gives the closing thresholds their own slots', () => {
    expect(announcementKey(remainingIn(60))).toBe('under:60');
    expect(announcementKey(remainingIn(31))).toBe('under:60');
    expect(announcementKey(remainingIn(30))).toBe('under:30');
    expect(announcementKey(remainingIn(11))).toBe('under:30');
    expect(announcementKey(remainingIn(10))).toBe('under:10');
    expect(announcementKey(remainingIn(1))).toBe('under:10');
  });

  it('holds one slot for the whole clamped range', () => {
    expect(announcementKey(remainingIn(2000 * 3600))).toBe('clamped');
    expect(announcementKey(remainingIn(1500 * 3600))).toBe('clamped');
  });

  it('has a slot of its own for expiry', () => {
    expect(announcementKey(computeRemaining(0, 1))).toBe('expired');
  });
});

describe('countdownAnnouncement', () => {
  it('names the target when asked, so the duration is not orphaned', () => {
    const announcement = countdownAnnouncement(remainingIn(3600), { label: 'New Year' });
    expect(announcement.text).toBe('Counting down to New Year. 1 hour remaining.');
    expect(announcement.key).toBe(announcementKey(remainingIn(3600)));
  });

  it('says the target arrived rather than counting down to it', () => {
    expect(countdownAnnouncement(computeRemaining(0, 1), { label: 'New Year' }).text).toBe(
      'New Year has arrived. Time is up.',
    );
  });

  it('omits the label when there is none to give', () => {
    expect(countdownAnnouncement(remainingIn(3600)).text).toBe('1 hour remaining.');
    expect(countdownAnnouncement(remainingIn(3600), { label: '  ' }).text).toBe(
      '1 hour remaining.',
    );
  });
});
