/**
 * Lighting-mood presets: the viewer-facing view of `EnvironmentSpec`.
 *
 * A "mood" is an `EnvironmentPresetId` chosen at runtime that overrides the one
 * baked into the active `SceneDefinition`. `null` means "whatever the scene
 * declares", which is the default and what the picker starts on.
 *
 * Plain data, no three.js: `withEnvironmentPreset` returns a new definition and
 * `render/lighting.ts` is the only thing that turns a preset into pixels. Until
 * the IBL bead lands that module logs a warning for any non-`none` preset and
 * falls back to the analytic lights, so switching moods is wired end to end but
 * has no visible effect yet.
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
