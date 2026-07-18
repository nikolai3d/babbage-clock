/**
 * Turns a `TrueTimeStatus` into the sentence the status strip shows.
 *
 * Pure and DOM-free so the wording is unit-tested rather than eyeballed. The
 * policy comes from docs/timing.md: a synced clock says almost nothing, a
 * degraded one says so without blocking, and a clock more than five seconds out
 * gets a warning that names the direction and the size of the error — the
 * viewer's other clocks are wrong too, which is worth knowing.
 */

import type { TrueTimeStatus } from '../time/trueTime.js';

/** How loudly the strip should present itself. Maps to a CSS modifier. */
export type StatusLevel = 'ok' | 'info' | 'warn';

export interface StatusDescription {
  readonly level: StatusLevel;
  /** Short line for the strip. */
  readonly text: string;
  /** Longer explanation for the `title` and the accessible description. */
  readonly detail: string;
  /** True when the strip should stay visually quiet (the normal, synced case). */
  readonly quiet: boolean;
}

export interface StatusContext {
  /** True while the first sync attempt is still in flight. */
  readonly syncPending: boolean;
}

export function describeTimeStatus(
  status: TrueTimeStatus,
  context: StatusContext = { syncPending: false },
): StatusDescription {
  if (status.skewWarning) {
    const direction = status.offsetMs < 0 ? 'fast' : 'slow';
    const amount = formatDuration(Math.abs(status.offsetMs));
    return {
      level: 'warn',
      text: `Device clock is ${amount} ${direction}`,
      detail:
        `This device's clock is about ${amount} ${direction} compared with network time. ` +
        'The countdown below is corrected, but your other clocks are not.',
      quiet: false,
    };
  }

  if (context.syncPending && !status.synced) {
    return {
      level: 'info',
      text: 'Checking world time',
      detail: 'Comparing this device against a network time source.',
      quiet: true,
    };
  }

  if (status.degraded) {
    return {
      level: 'warn',
      text: 'Device clock — may be inaccurate',
      detail:
        'No network time source could be reached, so the countdown is running on this ' +
        "device's clock. It is as accurate as the device is.",
      quiet: false,
    };
  }

  if (status.tier === 'http-date') {
    return {
      level: 'info',
      text: 'Accurate to about a second',
      detail:
        'Synced from an HTTP Date header, which has one-second resolution. Good enough to ' +
        'watch, not to start a race with.',
      quiet: true,
    };
  }

  return {
    level: 'ok',
    text: 'Synced to network time',
    detail: describeSyncedDetail(status),
    quiet: true,
  };
}

function describeSyncedDetail(status: TrueTimeStatus): string {
  const source = status.sourceId ?? 'a network time source';
  const uncertainty = Number.isFinite(status.uncertaintyMs)
    ? ` (±${formatDuration(status.uncertaintyMs)})`
    : '';
  return `Synced against ${source}${uncertainty}.`;
}

/** Human duration for a millisecond magnitude: `450 ms`, `12 s`, `4 min`, `2.5 h`. */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms)) return 'unknown';
  const abs = Math.abs(ms);
  if (abs < 1_000) return `${Math.round(abs)} ms`;
  if (abs < 60_000) return `${Math.round(abs / 1_000)} s`;
  if (abs < 3_600_000) return `${Math.round(abs / 60_000)} min`;
  return `${(abs / 3_600_000).toFixed(1)} h`;
}
