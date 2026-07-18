import { describe, expect, it } from 'vitest';
import {
  ENVIRONMENT_PRESETS,
  parseEnvironmentPreset,
  sceneEnvironmentPreset,
  withEnvironmentPreset,
} from './environment.js';
import { sceneRegistry } from './scenes/index.js';

const scene = sceneRegistry.resolve(null);

describe('parseEnvironmentPreset', () => {
  it('accepts every id the union allows', () => {
    for (const preset of ENVIRONMENT_PRESETS) {
      expect(parseEnvironmentPreset(preset.id)).toBe(preset.id);
    }
  });

  it('rejects anything else without throwing', () => {
    expect(parseEnvironmentPreset('disco')).toBeNull();
    expect(parseEnvironmentPreset('')).toBeNull();
    expect(parseEnvironmentPreset(null)).toBeNull();
    expect(parseEnvironmentPreset(undefined)).toBeNull();
  });
});

describe('withEnvironmentPreset', () => {
  it('overrides the scene preset', () => {
    const original = sceneEnvironmentPreset(scene);
    const moody = withEnvironmentPreset(scene, 'busy-street');

    expect(original).not.toBe('busy-street');
    expect(sceneEnvironmentPreset(moody)).toBe('busy-street');
    // The registry's own definition must not be mutated: it is shared.
    expect(sceneEnvironmentPreset(scene)).toBe(original);
  });

  it('starts the shipped scenes on a real mood, not on "none"', () => {
    // The default look is the steampunk workshop; a scene that declared "none"
    // would render the analytic fallback and quietly lose its IBL.
    expect(sceneEnvironmentPreset(scene)).toBe('steampunk-workshop');
    for (const definition of sceneRegistry.list()) {
      expect(sceneEnvironmentPreset(definition)).not.toBe('none');
    }
  });

  it('leaves everything else alone', () => {
    const moody = withEnvironmentPreset(scene, 'night');
    expect(moody.id).toBe(scene.id);
    expect(moody.rings).toBe(scene.rings);
    expect(moody.materials).toBe(scene.materials);
    expect(moody.lighting.directional).toBe(scene.lighting.directional);
  });

  it('returns the same object when there is nothing to change', () => {
    expect(withEnvironmentPreset(scene, null)).toBe(scene);
    expect(withEnvironmentPreset(scene, sceneEnvironmentPreset(scene))).toBe(scene);
  });

  it('still describes a valid scene', () => {
    const moody = withEnvironmentPreset(scene, 'busy-street');
    expect(moody.lighting.environment?.preset).toBe('busy-street');
    expect(moody.lighting.background).toBe(scene.lighting.background);
  });
});
