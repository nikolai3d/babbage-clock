import { describe, expect, it } from 'vitest';
import {
  HIGH_TIER_MAX_PIXEL_RATIO,
  LOW_TIER_MAX_FPS,
  LOW_TIER_MAX_PIXEL_RATIO,
  detectQualityTier,
  parseQualityPreference,
  qualitySettings,
  resolveQualityTier,
} from './quality.js';
import type { DeviceProfile } from './quality.js';

/** A capable desktop: the profile every rule has to leave alone. */
const desktop: DeviceProfile = {
  devicePixelRatio: 1,
  viewportWidth: 1440,
  viewportHeight: 900,
  hardwareConcurrency: 12,
  coarsePointer: false,
  deviceMemoryGb: 16,
};

const phone: DeviceProfile = {
  devicePixelRatio: 3,
  viewportWidth: 390,
  viewportHeight: 844,
  hardwareConcurrency: 6,
  coarsePointer: true,
  deviceMemoryGb: null,
};

describe('detectQualityTier', () => {
  it('leaves a capable desktop on the high tier', () => {
    expect(detectQualityTier(desktop)).toBe('high');
  });

  it('puts a phone on the low tier', () => {
    expect(detectQualityTier(phone)).toBe('low');
  });

  it('puts a phone in landscape on the low tier too', () => {
    // The short side is what identifies a handheld, not the width.
    expect(
      detectQualityTier({ ...phone, viewportWidth: 844, viewportHeight: 390 }),
    ).toBe('low');
  });

  it('does not demote a desktop with a touchscreen', () => {
    expect(detectQualityTier({ ...desktop, coarsePointer: true })).toBe('high');
  });

  it('demotes a machine with few cores', () => {
    expect(detectQualityTier({ ...desktop, hardwareConcurrency: 4 })).toBe('low');
  });

  it('demotes a machine that reports little memory', () => {
    expect(detectQualityTier({ ...desktop, deviceMemoryGb: 4 })).toBe('low');
  });

  it('demotes a large scaled display without the cores to feed it', () => {
    // A 5K-scaled panel on a 6-core machine: 3840x2160 device pixels.
    expect(
      detectQualityTier({
        ...desktop,
        devicePixelRatio: 2,
        viewportWidth: 1920,
        viewportHeight: 1080,
        hardwareConcurrency: 6,
      }),
    ).toBe('low');
  });

  it('keeps that same display on the high tier when the cores are there', () => {
    expect(
      detectQualityTier({
        ...desktop,
        devicePixelRatio: 2,
        viewportWidth: 1920,
        viewportHeight: 1080,
        hardwareConcurrency: 16,
      }),
    ).toBe('high');
  });
});

describe('qualitySettings', () => {
  it('caps pixel ratio harder on the low tier', () => {
    expect(qualitySettings('high').maxPixelRatio).toBe(HIGH_TIER_MAX_PIXEL_RATIO);
    expect(qualitySettings('low').maxPixelRatio).toBe(LOW_TIER_MAX_PIXEL_RATIO);
  });

  it('drops the panorama background and caps the frame rate on the low tier', () => {
    const low = qualitySettings('low');
    expect(low.panoramaBackground).toBe(false);
    expect(low.maxFps).toBe(LOW_TIER_MAX_FPS);
    expect(low.textureSize).toBe('half');
  });

  it('leaves the high tier uncapped', () => {
    const high = qualitySettings('high');
    expect(high.panoramaBackground).toBe(true);
    expect(high.maxFps).toBeNull();
    expect(high.textureSize).toBe('full');
  });
});

describe('resolveQualityTier', () => {
  it('consults the heuristic only for auto', () => {
    expect(resolveQualityTier('auto', phone)).toBe('low');
    // The viewer overrides the heuristic in both directions — a tier that
    // cannot be escaped is a bug report waiting to happen.
    expect(resolveQualityTier('high', phone)).toBe('high');
    expect(resolveQualityTier('low', desktop)).toBe('low');
  });
});

describe('parseQualityPreference', () => {
  it('accepts the two explicit tiers, case-insensitively', () => {
    expect(parseQualityPreference('low')).toBe('low');
    expect(parseQualityPreference(' HIGH ')).toBe('high');
  });

  it('treats anything else as auto rather than as an error', () => {
    for (const raw of [null, undefined, '', 'ultra', 'auto']) {
      expect(parseQualityPreference(raw)).toBe('auto');
    }
  });
});
