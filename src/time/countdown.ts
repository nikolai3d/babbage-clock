/**
 * Countdown maths. Pure functions over epoch milliseconds — no Date.now(), no
 * DOM, no three.js — so every case is unit-testable and the clock can be driven
 * from a synthetic time source.
 */

export const MS_PER_SECOND = 1000;
export const MS_PER_MINUTE = 60 * MS_PER_SECOND;
export const MS_PER_HOUR = 60 * MS_PER_MINUTE;
export const MS_PER_DAY = 24 * MS_PER_HOUR;

export interface CountdownParts {
  /** Signed milliseconds until the target; negative once the target has passed. */
  readonly totalMs: number;
  /** True when the target is in the past. All components stay non-negative. */
  readonly elapsed: boolean;
  readonly days: number;
  readonly hours: number;
  readonly minutes: number;
  readonly seconds: number;
  readonly milliseconds: number;
}

/** Splits the interval between `nowMs` and `targetMs` into calendar-ish parts. */
export function computeCountdown(targetMs: number, nowMs: number): CountdownParts {
  const totalMs = targetMs - nowMs;
  const magnitude = Math.abs(totalMs);

  return {
    totalMs,
    elapsed: totalMs < 0,
    days: Math.floor(magnitude / MS_PER_DAY),
    hours: Math.floor(magnitude / MS_PER_HOUR) % 24,
    minutes: Math.floor(magnitude / MS_PER_MINUTE) % 60,
    seconds: Math.floor(magnitude / MS_PER_SECOND) % 60,
    milliseconds: magnitude % MS_PER_SECOND,
  };
}

/** `DDDD:HH:MM:SS`-ish text for the HUD. */
export function formatCountdown(parts: CountdownParts): string {
  const pad = (value: number, width = 2): string => String(value).padStart(width, '0');
  const body = `${pad(parts.hours)}:${pad(parts.minutes)}:${pad(parts.seconds)}`;
  const days = parts.days > 0 ? `${parts.days}d ` : '';
  return `${parts.elapsed ? '+' : ''}${days}${body}`;
}

/**
 * Packs a countdown into `count` decimal digits, most significant first.
 *
 * Digits are taken from the concatenation `DD…D HH MM SS`, trimmed or
 * zero-padded on the left to fit the ring count. Seconds therefore always land
 * on the right-hand rings, whatever the ring count is — which is what keeps a
 * 7-ring and a 5-ring scene both looking sensible.
 */
export function countdownDigits(parts: CountdownParts, count: number): number[] {
  if (count < 1) return [];

  const pad = (value: number, width: number): string => String(value).padStart(width, '0');
  const full = `${parts.days}${pad(parts.hours, 2)}${pad(parts.minutes, 2)}${pad(parts.seconds, 2)}`;
  const fitted = full.length >= count ? full.slice(full.length - count) : full.padStart(count, '0');

  return [...fitted].map((char) => Number(char));
}

/**
 * Wall-clock digits (`HHMMSS`) for scenes running in `clock` mode.
 *
 * With fewer than six rings the least significant digits are dropped, so a
 * four-ring scene reads `HHMM` rather than `MMSS`; with more than six the
 * readout is zero-padded on the left. The planned 6-ring variant is the exact
 * fit and needs neither.
 */
export function clockDigits(date: Date, count: number): number[] {
  if (count < 1) return [];

  const pad = (value: number): string => String(value).padStart(2, '0');
  const full = `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
  const fitted = count >= full.length ? full.padStart(count, '0') : full.slice(0, count);

  return [...fitted].map((char) => Number(char));
}
