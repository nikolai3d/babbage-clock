import { copperPadlockScene } from './copperPadlock.js';
import type { SceneDefinition } from '../types.js';

export const COPPER_PADLOCK_CLOCK_SCENE_ID = 'copper-padlock-clock';

/**
 * The padlock as a wall clock: six rings — `HH MM SS` exactly — rolling
 * forward instead of down.
 *
 * This is the scene the scaffold's multi-scene note promised as the first
 * concrete second ring configuration: everything except the ring count, the
 * ring spacing, the separators and the mode is inherited from the copper
 * padlock, and no render code knows the difference. Six drums on the same arbor
 * sit a little airier in the same case, which reads deliberately, like a
 * different instrument from the same workshop.
 *
 * `spacing` and `separators` are pinned here rather than inherited. The copper
 * countdown tightened its spacing and grew two colon drums to read `HHH:MM:SS`;
 * this clock keeps the original airier `0.5` and no colons, so its layout is
 * unchanged from before that work. (Giving the clock its own `HH:MM:SS` colons —
 * after the second and fourth rings — is a natural follow-up, not this bead.)
 *
 * A viewer can equally put any scene in clock mode with `?mode=clock`; a
 * seven-ring scene then shows a zero-padded leading ring. This scene is the
 * native home: the layout is built for the reading.
 */
export const copperPadlockClockScene: SceneDefinition = {
  ...copperPadlockScene,
  id: COPPER_PADLOCK_CLOCK_SCENE_ID,
  name: 'Copper Padlock — Clock',
  description: 'The padlock as a wall clock: six rings of current time, rolling forward.',
  mode: 'clock',
  rings: {
    ...copperPadlockScene.rings,
    count: 6,
    spacing: 0.5,
    separators: [],
  },
};
