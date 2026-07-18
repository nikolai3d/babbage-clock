/**
 * Presentation of a `ResolvedTarget`: what the panel actually reads out.
 *
 * The target is echoed in **both** zones — the one it was entered in and the
 * viewer's — because that is what makes a mistyped zone visible instead of
 * silently three hours out. DST adjustments are surfaced with the sentence the
 * timing module already wrote; nothing is reworded here, so the two never drift
 * apart.
 *
 * Pure and DOM-free.
 */

import type { Disambiguation, ResolvedTarget, ZoneEcho } from '../time/target.js';

export interface TargetEchoLine {
  /** Row caption, e.g. `Entered zone`. */
  readonly caption: string;
  readonly zone: string;
  /** `YYYY-MM-DD HH:mm:ss`, space-separated for reading. */
  readonly wallClock: string;
  readonly offset: string;
  /** The timing module's locale-independent one-liner. */
  readonly formatted: string;
}

export interface TargetSummary {
  /** The target's own label, e.g. `New Year 2027`. */
  readonly headline: string;
  readonly entered: TargetEchoLine;
  /**
   * The same instant in the viewer's zone, or null when that is the zone it was
   * entered in — echoing an identical line twice is noise, not reassurance.
   */
  readonly viewer: TargetEchoLine | null;
  /** Short tag for a DST adjustment, or null in the ordinary case. */
  readonly adjustment: string | null;
  /** Where this target came from, phrased for display. */
  readonly origin: string;
  /** Displayable sentences, minus the expiry one (that is a state, not a note). */
  readonly notes: readonly string[];
  readonly expired: boolean;
}

const EXPIRY_NOTE = 'This target is in the past.';

const ADJUSTMENT_LABELS: Record<Disambiguation, string | null> = {
  none: null,
  'gap-forward': 'Daylight-saving gap — moved forward',
  'ambiguous-earlier': 'Ambiguous time — using the earlier one',
};

const ORIGIN_LABELS = {
  url: 'From the shared link',
  'default-new-year': 'Default target — the next New Year in your zone',
  input: 'Set by you',
} as const;

export function summarizeTarget(target: ResolvedTarget): TargetSummary {
  const sameZone = target.enteredZone.zone === target.viewerZone.zone;

  return {
    headline: target.label,
    entered: toLine(sameZone ? 'Target' : 'Entered zone', target.enteredZone),
    viewer: sameZone ? null : toLine('Your zone', target.viewerZone),
    adjustment: ADJUSTMENT_LABELS[target.disambiguation],
    origin: ORIGIN_LABELS[target.source],
    notes: target.notes.filter((note) => note !== EXPIRY_NOTE),
    expired: target.expired,
  };
}

function toLine(caption: string, echo: ZoneEcho): TargetEchoLine {
  return {
    caption,
    zone: echo.zone,
    wallClock: echo.wallClock.replace('T', ' '),
    offset: echo.offset,
    formatted: echo.formatted,
  };
}

/**
 * The `<input type="datetime-local">` value for a target.
 *
 * The input is stepped to whole seconds, and `ZoneEcho.wallClock` is already
 * `YYYY-MM-DDTHH:mm:ss` — the exact format the control wants — so this is a
 * pass-through that exists to keep the assumption in one asserted place.
 */
export function toDateTimeLocalValue(target: ResolvedTarget): string {
  return target.enteredZone.wallClock;
}
