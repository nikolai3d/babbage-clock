/**
 * Adapters from the clock to the mechanism.
 *
 * The mechanism itself knows nothing about countdowns, wall clocks or the
 * 999-hour cap: it is handed digits, a tick sequence and an expiry flag. These
 * two functions are the only place that mapping is decided, which is what lets
 * the state machine be tested against raw digit arrays.
 */

import { clockDigitsZoned, type ClockOptions } from '../time/clock.js';
import { remainingDigits, type RemainingTime } from '../time/countdown.js';
import type { MechanismInput } from './mechanism.js';

/**
 * A countdown frame.
 *
 * The sequence is `-totalSeconds`, so it advances by exactly one per second of
 * countdown — and, importantly, does *not* advance while the remaining time is
 * clamped at the display cap. A target 4,000 hours out therefore holds the
 * rings still at `999:59:59` instead of grinding through corrections, and the
 * first second under the cap is an ordinary tick.
 */
export function countdownFrame(remaining: RemainingTime, ringCount: number): MechanismInput {
  return {
    digits: remainingDigits(remaining, ringCount),
    sequence: -remaining.totalSeconds,
    expired: remaining.expired,
    direction: 'down',
  };
}

/**
 * A wall-clock frame, for scenes in `clock` mode.
 *
 * Counting up turns the drums the other way; the sequence comes from the epoch
 * rather than from the time of day so that midnight is an ordinary tick and not
 * a jump.
 */
export function clockFrame(
  nowMs: number,
  ringCount: number,
  options: ClockOptions = {},
): MechanismInput {
  return {
    digits: clockDigitsZoned(nowMs, ringCount, options),
    sequence: Math.floor(nowMs / 1000),
    expired: false,
    direction: 'up',
  };
}
