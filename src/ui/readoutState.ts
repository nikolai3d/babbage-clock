/**
 * The one-line note under the countdown.
 *
 * Pure so it can be tested without a DOM, in the same spirit as `statusText.ts`
 * and `countdownSpeech.ts`.
 */

import { formatRemaining } from '../time/countdown.js';
import type { CountdownParts, RemainingTime } from '../time/countdown.js';

/**
 * Explains the readout when it needs explaining, and says nothing otherwise.
 *
 * The readout counts in days; the rings cannot, because they have only
 * `HHH:MM:SS` to work with and stop at the 999-hour cap. Past that point the
 * two are both correct and visibly disagree — the readout might say
 * `199d 12:00:00` while every ring sits on `999:59:59` — which reads as a bug
 * unless the cap is stated outright.
 *
 * Expiry outranks the cap: once time is up there is no cap left to explain.
 */
export function readoutStateText(countdown: CountdownParts, remaining: RemainingTime): string {
  if (countdown.elapsed) return 'Time up';
  if (!remaining.clamped) return '';
  // `formatRemaining` would prefix a clamped value with `>`, which is the one
  // thing this sentence must not say: the rings are *at* the cap, not past it.
  return `rings hold at ${formatRemaining({ ...remaining, clamped: false })}`;
}
