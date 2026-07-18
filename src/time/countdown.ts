/**
 * Countdown maths. Pure functions over epoch milliseconds — no Date.now(), no
 * DOM, no three.js — so every case is unit-testable and the clock can be driven
 * from a synthetic time source.
 */

export const MS_PER_SECOND = 1000;
export const MS_PER_MINUTE = 60 * MS_PER_SECOND;
export const MS_PER_HOUR = 60 * MS_PER_MINUTE;
export const MS_PER_DAY = 24 * MS_PER_HOUR;

/** The display is `HHH:MM:SS`, so anything past this reads as the cap. */
export const MAX_DISPLAY_HOURS = 999;
export const MAX_DISPLAY_SECONDS = MAX_DISPLAY_HOURS * 3600 + 59 * 60 + 59;

export interface RemainingTime {
  /** Whole seconds left, clamped to the display cap and never negative. */
  readonly totalSeconds: number;
  /** Whole seconds left before clamping; negative once the target has passed. */
  readonly rawTotalSeconds: number;
  /** 0…999. */
  readonly hours: number;
  readonly minutes: number;
  readonly seconds: number;
  /** True while the real remaining time exceeds `MAX_DISPLAY_SECONDS`. */
  readonly clamped: boolean;
  /** True once the target instant has arrived; all components are then zero. */
  readonly expired: boolean;
}

/**
 * Remaining time as the rings display it: `HHH:MM:SS`, clamped at 999:59:59.
 *
 * Seconds are floored, so the readout shows `00:00:01` for the whole of the
 * final second and only reaches `00:00:00` at expiry. Beyond the cap the
 * display pins at 999:59:59 and `clamped` is set, so the UI can show a "more
 * than" affordance instead of silently lying about the magnitude.
 */
export function computeRemaining(targetEpochMs: number, nowMs: number): RemainingTime {
  const remainingMs = targetEpochMs - nowMs;
  const rawTotalSeconds = Math.floor(remainingMs / MS_PER_SECOND);

  // Expiry is decided on the millisecond, not the floored second: with 300 ms
  // left the readout is `000:00:00` but the target has not arrived yet, and
  // firing the expiry state early would be a visible lie.
  if (remainingMs <= 0) {
    return {
      totalSeconds: 0,
      rawTotalSeconds,
      hours: 0,
      minutes: 0,
      seconds: 0,
      clamped: false,
      expired: true,
    };
  }

  const clamped = rawTotalSeconds > MAX_DISPLAY_SECONDS;
  const totalSeconds = clamped ? MAX_DISPLAY_SECONDS : Math.max(0, rawTotalSeconds);

  return {
    totalSeconds,
    rawTotalSeconds,
    hours: Math.floor(totalSeconds / 3600),
    minutes: Math.floor(totalSeconds / 60) % 60,
    seconds: totalSeconds % 60,
    clamped,
    expired: false,
  };
}

/** `HHH:MM:SS` text, with a `>` prefix while the value is clamped. */
export function formatRemaining(remaining: RemainingTime): string {
  const pad = (value: number, width = 2): string => String(value).padStart(width, '0');
  const body = `${pad(remaining.hours, 3)}:${pad(remaining.minutes)}:${pad(remaining.seconds)}`;
  return remaining.clamped ? `>${body}` : body;
}

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
