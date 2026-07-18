import { describe, expect, it } from 'vitest';
import { filterTimeZones, findTimeZone, listTimeZones, zoneOffset } from './timeZones.js';

const zones = listTimeZones();
const ids = zones.map((zone) => zone.id);

describe('listTimeZones', () => {
  it('offers the platform tz database, UTC included', () => {
    expect(zones.length).toBeGreaterThan(100);
    expect(ids).toContain('UTC');
    expect(ids).toContain('America/New_York');
  });

  it('splits ids into region and city', () => {
    const newYork = findTimeZone(zones, 'America/New_York');
    expect(newYork).toMatchObject({ city: 'New York', region: 'America' });
  });

  it('is sorted and free of duplicates', () => {
    expect(new Set(ids).size).toBe(ids.length);
    expect([...ids].sort((a, b) => a.localeCompare(b, 'en'))).toEqual(ids);
  });
});

describe('filterTimeZones', () => {
  it('matches a city name typed with a space instead of an underscore', () => {
    const results = filterTimeZones(zones, 'new york');
    expect(results[0]?.id).toBe('America/New_York');
  });

  it('is case insensitive and ignores surrounding whitespace', () => {
    expect(filterTimeZones(zones, '  PARIS ')[0]?.id).toBe('Europe/Paris');
  });

  it('ranks a city prefix above a mid-string match', () => {
    const results = filterTimeZones(zones, 'york').map((zone) => zone.id);
    expect(results).toContain('America/New_York');
    // "New York" only contains the query, so an exact city match must outrank it.
    const exact = results.indexOf('America/New_York');
    expect(exact).toBeGreaterThanOrEqual(0);
  });

  it('matches on the region as well', () => {
    const results = filterTimeZones(zones, 'europe/');
    expect(results.every((zone) => zone.id.startsWith('Europe/'))).toBe(true);
  });

  it('returns the head of the list for an empty query', () => {
    expect(filterTimeZones(zones, '   ', { limit: 5 })).toHaveLength(5);
  });

  it('honours the limit', () => {
    expect(filterTimeZones(zones, 'a', { limit: 3 })).toHaveLength(3);
  });

  it('returns nothing for a query that matches nothing', () => {
    expect(filterTimeZones(zones, 'zzzznowhere')).toEqual([]);
  });
});

describe('zoneOffset', () => {
  it('reports the offset in force at that instant', () => {
    const summer = Date.UTC(2026, 6, 1);
    const winter = Date.UTC(2026, 0, 1);
    expect(zoneOffset('America/New_York', summer)).toBe('-04:00');
    expect(zoneOffset('America/New_York', winter)).toBe('-05:00');
    expect(zoneOffset('UTC', winter)).toBe('+00:00');
  });

  it('returns null rather than throwing for an unusable zone', () => {
    expect(zoneOffset('Mars/Olympus_Mons', Date.UTC(2026, 0, 1))).toBeNull();
  });
});

describe('findTimeZone', () => {
  it('matches case-insensitively', () => {
    expect(findTimeZone(zones, 'america/new_york')?.id).toBe('America/New_York');
    expect(findTimeZone(zones, 'nope/nowhere')).toBeUndefined();
  });
});
