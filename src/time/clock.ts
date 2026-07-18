/**
 * Wall-clock readings for clock mode.
 *
 * The countdown never needs a timezone — it is epoch arithmetic — but a clock
 * displays a *local* time somewhere, and "somewhere" is a real IANA zone with
 * DST, not a fixed offset. Temporal answers that here, in `time/`, so the
 * mechanism and renderer stay zone-ignorant: they are handed digits.
 */

import { Temporal } from 'temporal-polyfill';
import { viewerTimeZone } from './target.js';

export interface ClockParts {
  /** 0-23 in 24-hour form; 1-12 when `hours12` was asked for. */
  readonly hours: number;
  readonly minutes: number;
  readonly seconds: number;
  /** Present only in 12-hour form. */
  readonly meridiem?: 'AM' | 'PM';
  /** The zone the reading is in — echoed for the HUD. */
  readonly zone: string;
}

export interface ClockOptions {
  /** IANA zone or fixed offset; the viewer's own zone when omitted. */
  readonly zone?: string | null;
  /** 12-hour form with a meridiem instead of 0-23. */
  readonly hours12?: boolean;
}

export function clockParts(nowMs: number, options: ClockOptions = {}): ClockParts {
  const zone = options.zone ?? viewerTimeZone();
  // Floored: Temporal rejects fractional epochs, and clock seams have leaked
  // fractions into it twice already.
  const local = Temporal.Instant.fromEpochMilliseconds(Math.floor(nowMs)).toZonedDateTimeISO(zone);

  if (options.hours12) {
    return {
      hours: local.hour % 12 === 0 ? 12 : local.hour % 12,
      minutes: local.minute,
      seconds: local.second,
      meridiem: local.hour < 12 ? 'AM' : 'PM',
      zone,
    };
  }
  return { hours: local.hour, minutes: local.minute, seconds: local.second, zone };
}

/**
 * Clock digits (`HHMMSS`) for the rings, zone- and form-aware.
 *
 * Same fitting rules as the countdown packers: fewer rings drop the least
 * significant digits (a four-ring clock reads `HHMM`), more rings are
 * zero-padded on the left. In 12-hour form the hours are 01-12; the meridiem
 * has no ring and lives in the HUD.
 */
export function clockDigitsZoned(
  nowMs: number,
  count: number,
  options: ClockOptions = {},
): number[] {
  if (count < 1) return [];
  const parts = clockParts(nowMs, options);
  const pad = (value: number): string => String(value).padStart(2, '0');
  const full = `${pad(parts.hours)}${pad(parts.minutes)}${pad(parts.seconds)}`;
  const fitted = count >= full.length ? full.padStart(count, '0') : full.slice(0, count);
  return [...fitted].map((char) => Number(char));
}

/** `HH:MM:SS` (or `H:MM:SS AM`) for the HUD readout in clock mode. */
export function formatClock(parts: ClockParts): string {
  const pad = (value: number): string => String(value).padStart(2, '0');
  const body = `${parts.meridiem ? String(parts.hours) : pad(parts.hours)}:${pad(parts.minutes)}:${pad(parts.seconds)}`;
  return parts.meridiem ? `${body} ${parts.meridiem}` : body;
}
