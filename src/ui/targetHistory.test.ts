import { describe, expect, it } from 'vitest';
import { HISTORY_LIMIT, loadTargetHistory, pushTargetHistory } from './targetHistory.js';

function memoryStorage(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => void map.set(key, value),
  };
}

const entry = (n: number) => ({ value: `2026-12-3${String(n)}T12:00`, zone: 'UTC' });

describe('targetHistory', () => {
  it('starts empty and survives junk', () => {
    expect(loadTargetHistory(memoryStorage())).toEqual([]);
    expect(loadTargetHistory(memoryStorage({ 'babbage-clock:target-history': '{oops' }))).toEqual(
      [],
    );
    expect(loadTargetHistory(memoryStorage({ 'babbage-clock:target-history': '[1,2]' }))).toEqual(
      [],
    );
  });

  it('records newest first and reads back what it wrote', () => {
    const storage = memoryStorage();
    pushTargetHistory(storage, entry(1));
    const after = pushTargetHistory(storage, entry(2));
    expect(after[0]).toEqual(entry(2));
    expect(loadTargetHistory(storage)).toEqual(after);
  });

  it('deduplicates a re-applied target instead of stuttering', () => {
    const storage = memoryStorage();
    pushTargetHistory(storage, entry(1));
    pushTargetHistory(storage, entry(2));
    const after = pushTargetHistory(storage, entry(1));
    expect(after).toEqual([entry(1), entry(2)]);
  });

  it('caps the list', () => {
    const storage = memoryStorage();
    for (let i = 0; i <= HISTORY_LIMIT; i += 1) {
      pushTargetHistory(storage, { value: `2026-01-0${String(i + 1)}T00:00`, zone: 'UTC' });
    }
    expect(loadTargetHistory(storage)).toHaveLength(HISTORY_LIMIT);
  });

  it('treats a throwing storage as empty rather than crashing', () => {
    const hostile = {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('denied');
      },
    };
    expect(loadTargetHistory(hostile)).toEqual([]);
    expect(pushTargetHistory(hostile, entry(1))[0]).toEqual(entry(1));
  });
});
