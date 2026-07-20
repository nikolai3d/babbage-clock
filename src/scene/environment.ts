/**
 * Lighting-mood presets: the viewer-facing view of `EnvironmentSpec`.
 *
 * A "mood" is an `EnvironmentPresetId` chosen at runtime that overrides the one
 * baked into the active `SceneDefinition`. `null` means "whatever the scene
 * declares", which is the default and what the picker starts on.
 *
 * Plain data, no three.js: `withEnvironmentPreset` returns a new definition and
 * `render/lighting.ts` is the only thing that turns a preset into pixels. Each
 * id here matches a folder under `assets/ibl/`, which holds the panorama, the
 * light rig and the grade that make up the mood — see `docs/lighting.md`.
 *
 * Moods and scenes are orthogonal: any look renders under any mood, because a
 * mood only ever replaces lighting, background and grade.
 */

import type { EnvironmentPresetId, SceneDefinition } from './types.js';

export interface EnvironmentPreset {
  readonly id: EnvironmentPresetId;
  readonly name: string;
  readonly description: string;
}

/** Every preset the `EnvironmentPresetId` union allows, in picker order. */
export const ENVIRONMENT_PRESETS: readonly EnvironmentPreset[] = [
  {
    id: 'none',
    name: 'No environment',
    description: 'Analytic lights only — the scene lights itself.',
  },
  { id: 'day', name: 'Overcast day', description: 'Soft, even daylight.' },
  { id: 'sunny-day', name: 'Sunny day', description: 'Hard sun with strong speculars.' },
  { id: 'night', name: 'Night', description: 'Dim, cool, high contrast.' },
  {
    id: 'steampunk-workshop',
    name: 'Steampunk workshop',
    description: 'Warm brass-and-lamplight interior.',
  },
  { id: 'busy-street', name: 'Busy street', description: 'Mixed city light, many sources.' },
] as const;

const PRESET_IDS = new Set<string>(ENVIRONMENT_PRESETS.map((preset) => preset.id));

/** Narrows an untrusted string (e.g. `?mood=`) to a preset id, or null. */
export function parseEnvironmentPreset(
  value: string | null | undefined,
): EnvironmentPresetId | null {
  if (!value) return null;
  const trimmed = value.trim();
  return PRESET_IDS.has(trimmed) ? (trimmed as EnvironmentPresetId) : null;
}

/**
 * Treats an arbitrary loadable preset-folder id as an `EnvironmentPresetId`.
 *
 * `EnvironmentPresetId` is the *picker catalogue* — the curated moods the UI and
 * `?mood=` offer. The runtime, though, can load any folder under `assets/ibl/`:
 * the `?moodOverride=` test hook deliberately reaches CI fixtures (`test-*`) the
 * picker rejects, and unit fixtures name ids like `warm`. Those are loadable but
 * uncatalogued, so this is the one named, documented seam that bridges the two —
 * `render/lighting.ts` keys `EnvironmentSource` on a plain string, so nothing
 * downstream is misled. Far better than an `as EnvironmentPresetId` re-derived at
 * each call site. See babbage-clock-b8t.
 */
export function unlistedPreset(folder: string): EnvironmentPresetId {
  return folder as EnvironmentPresetId;
}

/** The preset a scene renders with when the viewer has not overridden it. */
export function sceneEnvironmentPreset(definition: SceneDefinition): EnvironmentPresetId {
  return definition.lighting.environment?.preset ?? 'none';
}

/**
 * A copy of `definition` whose environment preset is `preset`.
 *
 * Returns the original object when `preset` is null or already in effect, so
 * `setScene` can be called unconditionally without rebuilding the scene graph
 * for a no-op change.
 */
export function withEnvironmentPreset(
  definition: SceneDefinition,
  preset: EnvironmentPresetId | null,
): SceneDefinition {
  if (preset === null || preset === sceneEnvironmentPreset(definition)) return definition;

  return {
    ...definition,
    lighting: {
      ...definition.lighting,
      environment: { ...definition.lighting.environment, preset },
    },
  };
}
