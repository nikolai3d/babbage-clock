/**
 * Recently used countdown targets, persisted across visits.
 *
 * A plain value store, not a settings control: history entries are things the
 * viewer *did*, so they are recorded at the moment a target is applied and
 * offered back as one-tap chips. Storage is injected so the module tests
 * without a browser, and every read tolerates junk — localStorage survives
 * schema changes, other tabs and hand editing, so nothing here may throw.
 */

export interface TargetHistoryEntry {
  /** Wall clock exactly as it was applied, `datetime-local` shaped. */
  readonly value: string;
  /** IANA zone or fixed offset the wall clock was expressed in. */
  readonly zone: string;
}

const KEY = 'babbage-clock:target-history';

/** Enough to be useful, few enough to stay one row of chips. */
export const HISTORY_LIMIT = 4;

type StorageLike = Pick<Storage, 'getItem' | 'setItem'>;

export function loadTargetHistory(storage: StorageLike): TargetHistoryEntry[] {
  let raw: string | null = null;
  try {
    raw = storage.getItem(KEY);
  } catch {
    return [];
  }
  if (raw === null) return [];

  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (entry): entry is TargetHistoryEntry =>
          typeof entry === 'object' &&
          entry !== null &&
          typeof (entry as TargetHistoryEntry).value === 'string' &&
          typeof (entry as TargetHistoryEntry).zone === 'string',
      )
      .slice(0, HISTORY_LIMIT);
  } catch {
    return [];
  }
}

/**
 * Records an applied target, newest first, deduplicated by value and zone.
 *
 * Returns the updated list so the caller can re-render without a second read.
 * A full storage (private browsing quotas) loses the write, never the session.
 */
export function pushTargetHistory(
  storage: StorageLike,
  entry: TargetHistoryEntry,
): TargetHistoryEntry[] {
  const existing = loadTargetHistory(storage);
  const next = [
    entry,
    ...existing.filter((item) => item.value !== entry.value || item.zone !== entry.zone),
  ].slice(0, HISTORY_LIMIT);

  try {
    storage.setItem(KEY, JSON.stringify(next));
  } catch {
    // Quota or privacy mode: the chips still update for this session.
  }
  return next;
}
