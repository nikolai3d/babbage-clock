/**
 * Countdown target resolution.
 *
 * Deliberately minimal: a dedicated bead adds real timezone handling and NTP
 * clock-offset correction. Everything here sits behind `TimeSource` and
 * `CountdownTarget` so that bead can swap implementations without touching the
 * renderer, the UI or the app store.
 */

/** The seam the NTP bead replaces. `SystemTimeSource` is the scaffold default. */
export interface TimeSource {
  /** Current epoch milliseconds, ideally corrected for client clock skew. */
  now(): number;
}

export const systemTimeSource: TimeSource = {
  now: () => Date.now(),
};

export interface CountdownTarget {
  /** Human-readable description shown in the HUD. */
  readonly label: string;
  /** Target instant in epoch milliseconds. */
  readonly atMs: number;
  /** How the target was chosen — useful for diagnostics and the UI. */
  readonly source: 'url' | 'default-new-year';
}

/**
 * The next 1 January 00:00:00 in the viewer's local timezone.
 *
 * Constructing the Date from local components is what makes this
 * timezone-correct for the viewer without any tz database: the browser applies
 * its own offset. Always strictly in the future, including on New Year's Day.
 */
export function nextNewYear(nowMs: number): Date {
  const now = new Date(nowMs);
  return new Date(now.getFullYear() + 1, 0, 1, 0, 0, 0, 0);
}

/**
 * Parses a `?target=` value. Accepts anything `Date` understands, which in
 * practice means ISO 8601 — with an offset (`2027-01-01T00:00:00Z`) it is an
 * absolute instant, without one it is interpreted in the viewer's timezone.
 */
export function parseTargetParam(raw: string | null | undefined): Date | null {
  if (!raw) return null;

  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/** Resolves the effective countdown target, falling back to the next New Year. */
export function resolveCountdownTarget(
  rawParam: string | null | undefined,
  nowMs: number,
): CountdownTarget {
  const fromUrl = parseTargetParam(rawParam);
  if (fromUrl) {
    return { label: formatTargetLabel(fromUrl), atMs: fromUrl.getTime(), source: 'url' };
  }

  const newYear = nextNewYear(nowMs);
  return {
    label: `New Year ${newYear.getFullYear()}`,
    atMs: newYear.getTime(),
    source: 'default-new-year',
  };
}

function formatTargetLabel(date: Date): string {
  return date.toLocaleString(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  });
}
