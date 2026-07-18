/**
 * The one-line note under the countdown.
 *
 * Pure so it can be tested without a DOM, in the same spirit as `statusText.ts`
 * and `countdownSpeech.ts`.
 */

import { MAX_DISPLAY_HOURS } from '../time/countdown.js';
import type { CountdownParts, RemainingTime } from '../time/countdown.js';

/**
 * Explains the readout when it needs explaining, and says nothing otherwise.
 *
 * The readout counts in days; the rings cannot, because they have only
 * `HHH:MM:SS` to work with and their hours stop at 999. Past that point the two
 * are both correct and visibly disagree — the readout might say `199d 12:00:00`
 * while the hour rings sit on `999` — which reads as a bug unless the cap is
 * stated outright.
 *
 * Expiry outranks the cap: once time is up there is no cap left to explain.
 */
export function readoutStateText(countdown: CountdownParts, remaining: RemainingTime): string {
  if (countdown.elapsed) return 'Time up';
  if (!remaining.clamped) return '';
  // Only the hours pin at the cap — the minute and second rings keep running —
  // so the sentence names the hours rather than a whole frozen time.
  return `hours hold at ${MAX_DISPLAY_HOURS}`;
}
