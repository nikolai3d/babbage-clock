/**
 * How the countdown is *said* rather than shown, and how often.
 *
 * Pure: no DOM, no store, no timers — the phrasing and the throttling rule are
 * both plain functions of a `RemainingTime`, so every boundary is a unit test
 * rather than something to verify by ear with a screen reader running.
 *
 * The throttle is the important half. `#countdown` updates four times a second;
 * a live region fed from it would make a screen reader unusable. Announcements
 * are keyed instead: {@link announcementKey} maps a remaining time to the slot
 * it belongs to, and the announcer speaks only when the slot changes. That
 * yields one announcement per minute, one at each closing threshold, and one at
 * expiry — regardless of how often the state is pushed.
 */

import type { RemainingTime } from '../time/countdown.js';

/**
 * Closing thresholds, in seconds, that each get an announcement of their own.
 * Ascending, because {@link announcementKey} takes the tightest one that fits.
 */
export const ANNOUNCEMENT_THRESHOLDS = [10, 30, 60] as const;

export interface CountdownAnnouncement {
  /** Stable identity of the announcement slot; announce only when it changes. */
  readonly key: string;
  readonly text: string;
}

/**
 * The slot a remaining time falls in.
 *
 * Slots are coarse on purpose and change exactly as often as the app should
 * speak: once a minute down to a minute left, then at 60, 30 and 10 seconds,
 * then once at expiry.
 */
export function announcementKey(remaining: RemainingTime): string {
  if (remaining.expired) return 'expired';
  if (remaining.clamped) return 'clamped';

  for (const threshold of ANNOUNCEMENT_THRESHOLDS) {
    if (remaining.totalSeconds <= threshold) return `under:${String(threshold)}`;
  }
  // Ceiling, so the slot changes on the minute boundary rather than a second
  // after it: 61 s and 120 s are both "2 minutes".
  return `minute:${String(Math.ceil(remaining.totalSeconds / 60))}`;
}

function plural(value: number, unit: string): string {
  return `${String(value)} ${unit}${value === 1 ? '' : 's'}`;
}

/**
 * The remaining time as a sentence — "41 hours, 12 minutes remaining".
 *
 * Not `HHH:MM:SS`: a screen reader reads that as "zero zero one colon zero
 * four colon…", which is both slower to hear and harder to hold in your head
 * than the words. Seconds appear only under an hour, where they are the part
 * that matters; above that they would change the sentence every second for no
 * useful gain.
 */
export function describeRemaining(remaining: RemainingTime): string {
  if (remaining.expired) return 'Time is up.';
  if (remaining.clamped) return 'More than 999 hours remaining.';

  const parts: string[] = [];
  if (remaining.hours > 0) parts.push(plural(remaining.hours, 'hour'));
  if (remaining.minutes > 0) parts.push(plural(remaining.minutes, 'minute'));
  // Under an hour seconds are the interesting figure; above it they are noise.
  // The `parts.length === 0` case covers a whole number of hours or minutes
  // with nothing else to say, and the final seconds where they are all there is.
  if (remaining.hours === 0 && (remaining.seconds > 0 || parts.length === 0)) {
    parts.push(plural(remaining.seconds, 'second'));
  }

  return `${parts.join(', ')} remaining.`;
}

export interface AnnouncementOptions {
  /** The target's human label, spoken with the first announcement only. */
  readonly label?: string;
}

/**
 * The announcement for a remaining time, with its slot key.
 *
 * `label` is included when given, which the announcer does for the first
 * announcement and after the viewer changes the target — so someone who cannot
 * see the screen learns *what* is being counted down to, not just a duration.
 */
export function countdownAnnouncement(
  remaining: RemainingTime,
  options: AnnouncementOptions = {},
): CountdownAnnouncement {
  const body = describeRemaining(remaining);
  const label = options.label?.trim();
  if (!label) return { key: announcementKey(remaining), text: body };

  const lead = remaining.expired ? `${label} has arrived.` : `Counting down to ${label}.`;
  return { key: announcementKey(remaining), text: `${lead} ${body}` };
}
