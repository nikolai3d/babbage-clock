import { describe, expect, it } from 'vitest';
import {
  buildShareParams,
  buildShareUrl,
  parseBackgroundPreference,
  readLaunchParams,
} from './urlParams.js';
import { resolveTarget, resolveTargetFromParams } from '../time/target.js';
import type { ShareableState } from './urlParams.js';

const NOW = Date.UTC(2026, 0, 15, 12, 0, 0);
const BASE = 'https://clock.example/app/?mockNow=1&scene=slate-orrery#frag';

function shareState(value: string, zone: string, overrides: Partial<ShareableState> = {}) {
  return {
    sceneId: 'copper-padlock',
    mood: null,
    background: null,
    target: resolveTarget({ value, zone, nowMs: NOW, viewerZone: 'America/New_York' }),
    ...overrides,
  } satisfies ShareableState;
}

describe('background preference', () => {
  it('round-trips through a share link', () => {
    const state = shareState('2026-12-31T23:59:59', 'America/New_York', { background: 'backdrop' });
    const params = readLaunchParams(new URL(buildShareUrl(BASE, state)).search);
    expect(params.background).toBe('backdrop');
  });

  it('stays out of the link when automatic', () => {
    // Auto is the shipped default; writing it would only make links longer.
    const state = shareState('2026-12-31T23:59:59', 'America/New_York');
    expect(buildShareUrl(BASE, state)).not.toContain('bg=');
  });

  it('treats junk as automatic, like an unknown scene', () => {
    expect(parseBackgroundPreference('sparkles')).toBeNull();
    expect(parseBackgroundPreference(null)).toBeNull();
    expect(parseBackgroundPreference('PANORAMA')).toBe('panorama');
  });
});

/** The whole point of the share button: what goes out must come back the same. */
function roundTrip(state: ShareableState): number {
  const params = readLaunchParams(new URL(buildShareUrl(BASE, state)).search);
  return resolveTargetFromParams({ target: params.target, tz: params.tz }, NOW, 'America/New_York')
    .atMs;
}

describe('readLaunchParams', () => {
  it('reads every parameter', () => {
    const params = readLaunchParams(
      '?scene=slate-orrery&target=2026-12-31T23:59:59&tz=Europe/Paris&mood=night&bg=backdrop&quality=low',
    );
    expect(params).toEqual({
      sceneId: 'slate-orrery',
      target: '2026-12-31T23:59:59',
      tz: 'Europe/Paris',
      mood: 'night',
      background: 'backdrop',
      quality: 'low',
    });
  });

  it('treats an unknown mood as absent rather than as an error', () => {
    expect(readLaunchParams('?mood=disco').mood).toBeNull();
    expect(readLaunchParams('').mood).toBeNull();
  });

  it('defaults the quality tier to automatic', () => {
    // The tier belongs to the device, so a link that says nothing about it must
    // let the recipient's own device decide.
    expect(readLaunchParams('').quality).toBe('auto');
    expect(readLaunchParams('?quality=ultra').quality).toBe('auto');
  });

  it('keeps the quality tier out of a shared link', () => {
    const params = buildShareParams(shareState('2026-12-31T23:59:59', 'Europe/Paris'));
    expect(params.has('quality')).toBe(false);
  });
});

describe('buildShareParams', () => {
  it('writes the target as a wall clock plus its zone', () => {
    const params = buildShareParams(shareState('2026-12-31T23:59:59', 'Europe/Paris'));
    expect(params.get('target')).toBe('2026-12-31T23:59:59');
    expect(params.get('tz')).toBe('Europe/Paris');
    expect(params.get('scene')).toBe('copper-padlock');
  });

  it('omits the mood when the scene default is in force', () => {
    expect(buildShareParams(shareState('2026-12-31T23:59', 'UTC')).has('mood')).toBe(false);
  });

  it('includes an explicit mood', () => {
    const state = shareState('2026-12-31T23:59', 'UTC', { mood: 'steampunk-workshop' });
    expect(buildShareParams(state).get('mood')).toBe('steampunk-workshop');
  });
});

describe('buildShareUrl', () => {
  it('leaves the timestamp and zone readable', () => {
    const url = buildShareUrl(BASE, shareState('2026-12-31T23:59:59', 'Europe/Paris'));
    expect(url).toContain('target=2026-12-31T23:59:59');
    expect(url).toContain('tz=Europe/Paris');
  });

  it('keeps a fixed offset escaped, since a bare + would read as a space', () => {
    const url = buildShareUrl(BASE, shareState('2026-12-31T23:59:59', '+05:30'));
    expect(url).toContain('tz=%2B05:30');
    expect(new URL(url).searchParams.get('tz')).toBe('+05:30');
  });

  it('drops the incoming query and fragment', () => {
    const url = new URL(buildShareUrl(BASE, shareState('2026-12-31T23:59', 'UTC')));
    expect(url.hash).toBe('');
    expect(url.pathname).toBe('/app/');
    expect(url.searchParams.get('mockNow')).toBeNull();
    expect(url.searchParams.get('scene')).toBe('copper-padlock');
  });
});

describe('share round-trip', () => {
  it('reproduces an ordinary instant', () => {
    const state = shareState('2026-12-31T23:59:59', 'Europe/Paris');
    expect(roundTrip(state)).toBe(state.target.atMs);
  });

  it('reproduces a target entered in the viewer zone', () => {
    const state = shareState('2026-07-04T20:00:00', 'America/New_York');
    expect(roundTrip(state)).toBe(state.target.atMs);
  });

  it('reproduces a fixed-offset zone', () => {
    const state = shareState('2026-12-31T23:59:59', '+05:30');
    expect(roundTrip(state)).toBe(state.target.atMs);
  });

  it('reproduces a daylight-saving gap target, adjustment and all', () => {
    const state = shareState('2026-03-08T02:30:00', 'America/New_York');
    expect(state.target.disambiguation).toBe('gap-forward');
    // The link carries the *resolved* 03:30, so the recipient does not re-run
    // the gap adjustment and land somewhere else.
    expect(buildShareParams(state).get('target')).toBe('2026-03-08T03:30:00');
    expect(roundTrip(state)).toBe(state.target.atMs);
  });

  it('reproduces an ambiguous fall-back target', () => {
    const state = shareState('2026-11-01T01:30:00', 'America/New_York');
    expect(state.target.disambiguation).toBe('ambiguous-earlier');
    expect(roundTrip(state)).toBe(state.target.atMs);
  });

  it('reproduces an instant entered with an explicit offset', () => {
    const state = shareState('2026-12-31T23:59:59Z', 'Asia/Tokyo');
    expect(roundTrip(state)).toBe(state.target.atMs);
  });

  it('reproduces a target already in the past', () => {
    const state = shareState('2020-01-01T00:00:00', 'UTC');
    expect(state.target.expired).toBe(true);
    expect(roundTrip(state)).toBe(state.target.atMs);
  });
});
