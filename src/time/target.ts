/**
 * Timezone-aware countdown target resolution.
 *
 * Every wall-clock -> instant conversion goes through the Temporal API (via
 * `temporal-polyfill`), which carries the real IANA tz database. Offset
 * arithmetic is never hand-rolled here and zone-less strings are never handed
 * to `Date`, because both silently produce the wrong instant across a DST
 * boundary.
 *
 * Pure module: no DOM, no network, no three.js.
 */

import { Temporal } from 'temporal-polyfill';

/** The seam the renderer injects. `trueTimeSource` is the corrected implementation. */
export interface TimeSource {
  /** Current epoch milliseconds, ideally corrected for client clock skew. */
  now(): number;
}

export const systemTimeSource: TimeSource = {
  now: () => Date.now(),
};

/** How the effective target was chosen. */
export type TargetSource = 'url' | 'default-new-year' | 'input';

/** What the tz database had to say about the requested wall-clock time. */
export type Disambiguation =
  /** The wall-clock time exists exactly once in the zone. The normal case. */
  | 'none'
  /** Spring-forward gap: the requested time never happens; resolved forward. */
  | 'gap-forward'
  /** Fall-back overlap: the time happens twice; the earlier instant was used. */
  | 'ambiguous-earlier';

/** The resolved instant rendered in one particular zone, for echoing back. */
export interface ZoneEcho {
  /** IANA id (`America/New_York`) or fixed offset (`+05:30`). */
  readonly zone: string;
  /** `YYYY-MM-DDTHH:mm:ss` wall clock in that zone. */
  readonly wallClock: string;
  /** UTC offset in effect at that instant, e.g. `-05:00`. */
  readonly offset: string;
  /**
   * Locale-independent human string: `2026-12-31 23:59:59 -05:00
   * (America/New_York)`. Deliberately not `toLocaleString` — the countdown must
   * read identically in CI, in tests and in every browser locale.
   */
  readonly formatted: string;
}

/** Kept for the app store; `ResolvedTarget` is the full shape. */
export interface CountdownTarget {
  /** Human-readable description shown in the HUD. */
  readonly label: string;
  /** Target instant in epoch milliseconds. */
  readonly atMs: number;
  /** How the target was chosen — useful for diagnostics and the UI. */
  readonly source: TargetSource;
}

export interface ResolvedTarget extends CountdownTarget {
  /** The zone the target was entered in (resolved: `local` becomes a real id). */
  readonly zone: string;
  /** The instant as seen from the entered zone. */
  readonly enteredZone: ZoneEcho;
  /** The same instant as seen from the viewer's zone. Mistakes show up here. */
  readonly viewerZone: ZoneEcho;
  /** Whether a DST gap or overlap was involved, and how it was settled. */
  readonly disambiguation: Disambiguation;
  /** The wall clock as typed, when disambiguation moved it. Otherwise null. */
  readonly requestedWallClock: string | null;
  /** True when the target instant is already in the past. */
  readonly expired: boolean;
  /** Non-fatal things the viewer should be told: adjustments, ignored params. */
  readonly notes: readonly string[];
}

export interface TargetInput {
  /**
   * A wall-clock date-time (`2026-12-31T23:59:59`, `2026-12-31 23:59`,
   * `2026-12-31`), or a full ISO 8601 instant carrying its own offset or `Z`.
   */
  readonly value: string;
  /**
   * IANA zone id, fixed offset (`+05:30`), `UTC`, or `local`/omitted for the
   * viewer's zone. Ignored for resolution when `value` already carries an
   * offset — the instant is then unambiguous — but still used for the echo.
   */
  readonly zone?: string | undefined;
  /** Overrides the generated label. */
  readonly label?: string | undefined;
  /** Where this came from. Defaults to `input`. */
  readonly source?: TargetSource | undefined;
  /** Current instant, for the expiry check. Defaults to `Date.now()`. */
  readonly nowMs?: number | undefined;
  /** The viewer's zone, for the second echo. Defaults to the system zone. */
  readonly viewerZone?: string | undefined;
}

export type TargetErrorCode = 'invalid-date-time' | 'invalid-zone';

/** Thrown for input that cannot be turned into an instant at all. */
export class TargetError extends Error {
  readonly code: TargetErrorCode;

  constructor(message: string, code: TargetErrorCode, options?: ErrorOptions) {
    super(message, options);
    this.name = 'TargetError';
    this.code = code;
  }
}

/** Matches a trailing `Z` or `±HH:MM` / `±HHMM` offset on an ISO string. */
const HAS_ZONE_RE = /(?:Z|[+-]\d{2}:?\d{2})$/i;
/** Matches a trailing `[Zone/Id]` bracket suffix, as Temporal itself emits. */
const HAS_BRACKET_ZONE_RE = /\[[^\]]+\]$/;

const LOCAL_ZONE_ALIASES = new Set(['', 'local', 'localtime', 'auto', 'viewer', 'system']);

/** The viewer's IANA zone id, e.g. `Europe/Paris`. */
export function viewerTimeZone(): string {
  return Temporal.Now.timeZoneId();
}

/**
 * Resolves a target specification to an instant, with both-zone echoes.
 *
 * DST handling is `disambiguation: 'compatible'`, which is exactly the two
 * behaviours the product wants: a nonexistent spring-forward time moves
 * forward past the gap, and an ambiguous fall-back time takes the earlier of
 * the two instants. Which of those happened is reported rather than hidden, so
 * the UI can say "02:30 does not exist on that date — using 03:30".
 *
 * @throws {TargetError} when the value or the zone cannot be parsed.
 */
export function resolveTarget(input: TargetInput): ResolvedTarget {
  const nowMs = input.nowMs ?? Date.now();
  const viewerZone = normalizeZone(input.viewerZone, viewerTimeZone());
  const requestedZone = normalizeZone(input.zone, viewerZone);
  const notes: string[] = [];

  const value = input.value.trim();
  if (value === '') throw new TargetError('Empty target value', 'invalid-date-time');

  let zoned: Temporal.ZonedDateTime;
  let disambiguation: Disambiguation = 'none';
  let requestedWallClock: string | null = null;
  let effectiveZone = requestedZone;

  if (HAS_BRACKET_ZONE_RE.test(value)) {
    // `2026-12-31T23:59:59+01:00[Europe/Paris]` — self-describing, take it whole.
    zoned = parseZonedString(value);
    effectiveZone = zoned.timeZoneId;
  } else if (HAS_ZONE_RE.test(value)) {
    // Absolute instant. A `tz` alongside it cannot change the instant.
    const instant = parseInstant(value);
    if (input.zone !== undefined && !LOCAL_ZONE_ALIASES.has(input.zone.trim().toLowerCase())) {
      notes.push(
        `"${value}" already carries a UTC offset, so the requested zone (${requestedZone}) was used only for display.`,
      );
    }
    zoned = inZone(instant.toZonedDateTimeISO('UTC'), requestedZone);
  } else {
    const plain = parsePlainDateTime(value);
    requestedWallClock = plain.toString({ smallestUnit: 'second' });

    const earlier = toZoned(plain, requestedZone, 'earlier');
    const later = toZoned(plain, requestedZone, 'later');
    zoned = toZoned(plain, requestedZone, 'compatible');

    if (!earlier.toPlainDateTime().equals(plain)) {
      // Nothing in the zone reads back as the requested wall clock: it fell in
      // a spring-forward gap and `compatible` pushed it past the transition.
      disambiguation = 'gap-forward';
      notes.push(
        `${requestedWallClock} does not exist in ${requestedZone} (daylight-saving gap) — using ${zoned.toPlainDateTime().toString({ smallestUnit: 'second' })} ${zoned.offset}.`,
      );
    } else if (earlier.epochMilliseconds !== later.epochMilliseconds) {
      disambiguation = 'ambiguous-earlier';
      notes.push(
        `${requestedWallClock} happens twice in ${requestedZone} (daylight-saving overlap) — using the earlier one, ${zoned.offset}.`,
      );
    } else {
      requestedWallClock = null;
    }
  }

  const atMs = zoned.epochMilliseconds;
  const enteredZone = describeZone(zoned, effectiveZone);
  const viewerEcho = describeZone(inZone(zoned, viewerZone), viewerZone);
  const expired = atMs <= nowMs;
  if (expired) notes.push('This target is in the past.');

  return {
    label: input.label ?? defaultLabel(enteredZone),
    atMs,
    source: input.source ?? 'input',
    zone: effectiveZone,
    enteredZone,
    viewerZone: viewerEcho,
    disambiguation,
    requestedWallClock,
    expired,
    notes,
  };
}

/** The `?target=` / `?tz=` pair, as read from the URL. */
export interface TargetParams {
  readonly target: string | null | undefined;
  readonly tz?: string | null | undefined;
}

/**
 * URL-facing resolution: never throws, always yields a live countdown.
 *
 * Unparseable input degrades to the default target with an explanatory note
 * rather than an error screen — a bad shared link should still show something.
 */
export function resolveTargetFromParams(
  params: TargetParams,
  nowMs: number,
  viewerZone?: string,
): ResolvedTarget {
  const raw = params.target?.trim();
  if (raw) {
    try {
      return resolveTarget({
        value: raw,
        zone: params.tz ?? undefined,
        source: 'url',
        nowMs,
        viewerZone,
      });
    } catch (error) {
      const reason = error instanceof TargetError ? error.message : 'unrecognised value';
      return withNote(defaultTarget(nowMs, viewerZone), `Ignored ?target=${raw} — ${reason}.`);
    }
  }

  return defaultTarget(nowMs, viewerZone);
}

/**
 * The same target instant re-anchored in another zone.
 *
 * Written for the clock-mode zone control: the viewer is changing the zone the
 * rings *read the current time in*, not the moment being counted down to, so
 * `atMs` is carried over exactly. Re-resolving the wall clock instead would
 * silently move the instant when it falls in a DST overlap (`compatible`
 * disambiguation always takes the earlier of the pair). The echoes, label,
 * expiry and notes are recomputed for the new zone; the label is regenerated
 * rather than kept, because a label like `New Year` reads wrong against a wall
 * clock that is no longer midnight.
 *
 * @throws {TargetError} when the zone cannot be used.
 */
export function retargetZone(
  target: ResolvedTarget,
  zone: string,
  nowMs: number,
  viewerZone?: string,
): ResolvedTarget {
  const fallback = normalizeZone(viewerZone, viewerTimeZone());
  const zoneId = normalizeZone(zone, fallback);
  const zoned = inZone(
    Temporal.Instant.fromEpochMilliseconds(target.atMs).toZonedDateTimeISO('UTC'),
    zoneId,
  );
  // `toString` yields `2027-01-01T08:00:00+09:00[Asia/Tokyo]` — self-describing,
  // so `resolveTarget` takes the instant whole: no disambiguation, no notes
  // about an offset overriding the zone, and the epoch survives to the digit.
  // Default precision on purpose: pinning `smallestUnit` would truncate a
  // target that carries sub-second milliseconds.
  return resolveTarget({
    value: zoned.toString(),
    source: target.source,
    nowMs,
    viewerZone,
  });
}

/**
 * Owner decision: with no `?target=`, count down to the next New Year in the
 * viewer's zone, so the landing page is never blank.
 */
export function defaultTarget(nowMs: number, viewerZone?: string): ResolvedTarget {
  const zone = normalizeZone(viewerZone, viewerTimeZone());
  const zoned = nextNewYearZoned(nowMs, zone);

  return resolveTarget({
    value: zoned.toPlainDateTime().toString({ smallestUnit: 'second' }),
    zone,
    label: `New Year ${zoned.year}`,
    source: 'default-new-year',
    nowMs,
    viewerZone: zone,
  });
}

/**
 * The wall clock `hours` from now in `zone`, to the minute.
 *
 * Seconds are dropped rather than rounded: "in one hour" spoken at 14:23:41
 * means 15:23, and a seconds-precision target would read as noise in the
 * input. Written for the quick-target buttons; anything needing an exact
 * instant should work in instants, not wall clocks.
 */
export function wallClockInHours(nowMs: number, hours: number, zone?: string): string {
  const zoneId = normalizeZone(zone, viewerTimeZone());
  // Floored: Temporal rejects fractional epochs, and clock seams have leaked
  // fractions twice now (the real clock, then the advance-mode mock).
  return Temporal.Instant.fromEpochMilliseconds(Math.floor(nowMs))
    .toZonedDateTimeISO(zoneId)
    .add({ hours })
    .toPlainDateTime()
    .toString({ smallestUnit: 'minute' });
}

/**
 * The next midnight in `zone` — "tonight at midnight" — as a wall clock.
 *
 * Always strictly in the future: at 00:00 exactly it returns the following
 * midnight. Midnight during a DST gap resolves like any other entered wall
 * clock, through `resolveTarget`'s disambiguation.
 */
export function nextMidnightWallClock(nowMs: number, zone?: string): string {
  const zoneId = normalizeZone(zone, viewerTimeZone());
  const local = Temporal.Instant.fromEpochMilliseconds(Math.floor(nowMs)).toZonedDateTimeISO(
    zoneId,
  );
  return local
    .toPlainDate()
    .add({ days: 1 })
    .toPlainDateTime()
    .toString({ smallestUnit: 'minute' });
}

/** The next 1 January 00:00:00 in `zone`, always strictly in the future. */
export function nextNewYearZoned(nowMs: number, zone?: string): Temporal.ZonedDateTime {
  const zoneId = normalizeZone(zone, viewerTimeZone());
  const local = Temporal.Instant.fromEpochMilliseconds(nowMs).toZonedDateTimeISO(zoneId);
  return Temporal.PlainDateTime.from({ year: local.year + 1, month: 1, day: 1 }).toZonedDateTime(
    zoneId,
    { disambiguation: 'compatible' },
  );
}

/** The next 1 January 00:00 in the viewer's zone. Kept for the scaffold API. */
export function nextNewYear(nowMs: number): Date {
  return new Date(nextNewYearZoned(nowMs).epochMilliseconds);
}

/**
 * Parses a `?target=` value to an instant, or null if it is unusable.
 *
 * Retained from the scaffold. Prefer `resolveTarget`, which reports DST
 * adjustments instead of swallowing them.
 */
export function parseTargetParam(
  raw: string | null | undefined,
  zone?: string | null,
): Date | null {
  if (!raw?.trim()) return null;
  try {
    return new Date(resolveTarget({ value: raw, zone: zone ?? undefined }).atMs);
  } catch {
    return null;
  }
}

/** Scaffold-compatible entry point, now timezone-aware. */
export function resolveCountdownTarget(
  rawParam: string | null | undefined,
  nowMs: number,
  tzParam?: string | null,
): ResolvedTarget {
  return resolveTargetFromParams({ target: rawParam, tz: tzParam }, nowMs);
}

/**
 * True when the string names a zone `resolveTarget` can use — an IANA id, a
 * fixed offset, or a `local` alias. The timezone-picker bead validates with it.
 */
export function isValidTimeZone(zone: string | null | undefined): boolean {
  try {
    toZoned(
      Temporal.PlainDateTime.from('2020-01-01T00:00'),
      normalizeZone(zone, 'UTC'),
      'compatible',
    );
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------

function withNote(target: ResolvedTarget, note: string): ResolvedTarget {
  return { ...target, notes: [note, ...target.notes] };
}

function defaultLabel(echo: ZoneEcho): string {
  return `${echo.wallClock.replace('T', ' ')} (${echo.zone})`;
}

function describeZone(zoned: Temporal.ZonedDateTime, zone: string): ZoneEcho {
  const wallClock = zoned.toPlainDateTime().toString({ smallestUnit: 'second' });
  const offset = zoned.offset;
  return {
    zone,
    wallClock,
    offset,
    formatted: `${wallClock.replace('T', ' ')} ${offset} (${zone})`,
  };
}

/** Re-anchors an instant in another zone, reporting a bad zone as a TargetError. */
function inZone(zoned: Temporal.ZonedDateTime, zone: string): Temporal.ZonedDateTime {
  try {
    return zoned.withTimeZone(zone);
  } catch (error) {
    throw new TargetError(`Unknown time zone "${zone}"`, 'invalid-zone', { cause: error });
  }
}

function toZoned(
  plain: Temporal.PlainDateTime,
  zone: string,
  disambiguation: 'compatible' | 'earlier' | 'later',
): Temporal.ZonedDateTime {
  try {
    return plain.toZonedDateTime(zone, { disambiguation });
  } catch (error) {
    throw new TargetError(`Unknown time zone "${zone}"`, 'invalid-zone', { cause: error });
  }
}

function parsePlainDateTime(value: string): Temporal.PlainDateTime {
  try {
    return Temporal.PlainDateTime.from(value);
  } catch (error) {
    throw new TargetError(`Could not read "${value}" as a date and time`, 'invalid-date-time', {
      cause: error,
    });
  }
}

function parseInstant(value: string): Temporal.Instant {
  try {
    return Temporal.Instant.from(value);
  } catch (error) {
    throw new TargetError(`Could not read "${value}" as an instant`, 'invalid-date-time', {
      cause: error,
    });
  }
}

function parseZonedString(value: string): Temporal.ZonedDateTime {
  try {
    return Temporal.ZonedDateTime.from(value);
  } catch (error) {
    throw new TargetError(
      `Could not read "${value}" as a zoned date and time`,
      'invalid-date-time',
      {
        cause: error,
      },
    );
  }
}

/** Maps `local`/empty to the fallback zone and validates everything else. */
function normalizeZone(zone: string | null | undefined, fallback: string): string {
  const trimmed = zone?.trim() ?? '';
  if (LOCAL_ZONE_ALIASES.has(trimmed.toLowerCase())) return fallback;
  return trimmed;
}
