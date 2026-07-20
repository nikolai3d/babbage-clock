import { SceneRegistry } from '../registry.js';
import { BABBAGE_ENGINE_SCENE_ID, babbageEngineScene } from './babbageEngine.js';
import { COPPER_PADLOCK_SCENE_ID, copperPadlockScene } from './copperPadlock.js';
import { COPPER_PADLOCK_CLOCK_SCENE_ID, copperPadlockClockScene } from './copperPadlockClock.js';
import { SLATE_ORRERY_SCENE_ID, slateOrreryScene } from './slateOrrery.js';
import type { SceneDefinition } from '../types.js';

export {
  COPPER_PADLOCK_SCENE_ID,
  COPPER_PADLOCK_CLOCK_SCENE_ID,
  SLATE_ORRERY_SCENE_ID,
  BABBAGE_ENGINE_SCENE_ID,
};

/**
 * The single place a new scene gets hooked up. Add the definition to this array
 * and it becomes selectable in the UI and via `?scene=<id>` automatically.
 *
 * `babbage-engine` — the authored-in-Blender clock — leads the list and is the
 * default: it is the direction the project is taking, with the procedural
 * copper/slate scenes kept as reachable alternatives and as the
 * degrade-to-procedural fallback behind the authored geometry.
 */
export const allScenes: readonly SceneDefinition[] = [
  babbageEngineScene,
  copperPadlockScene,
  copperPadlockClockScene,
  slateOrreryScene,
];

/** Application-wide registry. Construction validates every scene eagerly. */
export const sceneRegistry = new SceneRegistry(allScenes, BABBAGE_ENGINE_SCENE_ID);
