/**
 * The searchable timezone list behind the picker.
 *
 * Zones come from `Intl.supportedValuesOf('timeZone')` — the platform's own tz
 * database, ~420 entries — rather than a bundled list that would go stale. Every
 * candidate is checked with `isValidTimeZone` so nothing the picker offers can
 * fail to resolve.
 *
 * Pure and DOM-free: the matching rules are unit-tested, and `ui/timeZonePicker`
 * only draws what comes out of here.
 */

import { Temporal } from 'temporal-polyfill';
import { isValidTimeZone } from '../time/target.js';

export interface TimeZoneOption {
  /** IANA id, e.g. `America/New_York`. */
  readonly id: string;
  /** The id with underscores relaxed, e.g. `America/New York`. */
  readonly label: string;
  /** City-ish tail of the id, e.g. `New York`. */
  readonly city: string;
  /** Region head of the id, e.g. `America`. Empty for single-segment ids. */
  readonly region: string;
}

/** Ids that are always offered even if the platform omits them. */
const ALWAYS_INCLUDED = ['UTC'];

/**
 * Every zone this browser knows, sorted by id.
 *
 * Cached: the list cannot change within a session, and rebuilding it on every
 * keystroke would mean validating four hundred zones for nothing.
 */
let cachedZones: readonly TimeZoneOption[] | null = null;

export function listTimeZones(): readonly TimeZoneOption[] {
  cachedZones ??= buildZoneList();
  return cachedZones;
}

function buildZoneList(): readonly TimeZoneOption[] {
  const supported = supportedTimeZoneIds();
  const ids = new Set<string>([...supported, ...ALWAYS_INCLUDED]);

  return [...ids]
    .filter((id) => isValidTimeZone(id))
    .sort((a, b) => a.localeCompare(b, 'en'))
    .map(describeZoneId);
}

function supportedTimeZoneIds(): readonly string[] {
  // `supportedValuesOf` is ES2022 but not universal; a browser without it still
  // gets the viewer's own zone and UTC, which is enough to operate the picker.
  const supportedValuesOf = (Intl as unknown as { supportedValuesOf?: (key: string) => string[] })
    .supportedValuesOf;

  if (typeof supportedValuesOf !== 'function') {
    return [Temporal.Now.timeZoneId()];
  }
  try {
    return supportedValuesOf('timeZone');
  } catch {
    return [Temporal.Now.timeZoneId()];
  }
}

function describeZoneId(id: string): TimeZoneOption {
  const cut = id.lastIndexOf('/');
  const city = (cut === -1 ? id : id.slice(cut + 1)).replace(/_/g, ' ');
  const region = cut === -1 ? '' : id.slice(0, cut).replace(/_/g, ' ');
  return { id, label: id.replace(/_/g, ' '), city, region };
}

/**
 * The UTC offset in effect in `zone` at `atMs`, e.g. `-05:00`.
 *
 * Taken from Temporal rather than `toLocaleString`, so the picker reads
 * identically in every locale and in CI. Returns null for an unusable zone
 * instead of throwing, since this only ever decorates a label.
 */
export function zoneOffset(zone: string, atMs: number): string | null {
  try {
    return Temporal.Instant.fromEpochMilliseconds(atMs).toZonedDateTimeISO(zone).offset;
  } catch {
    return null;
  }
}

/** Normalises ids and queries to a common form: lower case, `_` and `/` as spaces. */
function normalize(value: string): string {
  return value.toLowerCase().replace(/[_/]+/g, ' ').replace(/\s+/g, ' ').trim();
}

export interface FilterOptions {
  /** Maximum results to return. Defaults to 50 — a listbox, not a phone book. */
  readonly limit?: number;
}

/**
 * Zones matching `query`, best first.
 *
 * Ranking, in order: exact id, city prefix ("york" does not beat "new york"),
 * region or full-label prefix, then anything containing the query. Ties keep
 * alphabetical order, so the list never jitters between keystrokes.
 *
 * An empty query returns the head of the full list rather than nothing, so the
 * listbox has something to show the moment it opens.
 */
export function filterTimeZones(
  zones: readonly TimeZoneOption[],
  query: string,
  options: FilterOptions = {},
): readonly TimeZoneOption[] {
  const limit = options.limit ?? 50;
  const needle = normalize(query);
  if (needle === '') return zones.slice(0, limit);

  const ranked: { zone: TimeZoneOption; rank: number }[] = [];
  for (const zone of zones) {
    const rank = rankZone(zone, needle);
    if (rank !== null) ranked.push({ zone, rank });
  }

  ranked.sort((a, b) => a.rank - b.rank || a.zone.id.localeCompare(b.zone.id, 'en'));
  return ranked.slice(0, limit).map((entry) => entry.zone);
}

function rankZone(zone: TimeZoneOption, needle: string): number | null {
  const id = normalize(zone.id);
  const city = normalize(zone.city);

  if (id === needle || city === needle) return 0;
  if (city.startsWith(needle)) return 1;
  if (id.startsWith(needle)) return 2;
  if (city.includes(needle)) return 3;
  if (id.includes(needle)) return 4;
  return null;
}

/** The zone in `zones` whose id matches `value` case-insensitively, if any. */
export function findTimeZone(
  zones: readonly TimeZoneOption[],
  value: string,
): TimeZoneOption | undefined {
  const wanted = value.trim().toLowerCase();
  return zones.find((zone) => zone.id.toLowerCase() === wanted);
}
