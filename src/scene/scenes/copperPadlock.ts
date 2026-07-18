import { placeholder } from '../materialHelpers.js';
import type { SceneDefinition } from '../types.js';

export const COPPER_PADLOCK_SCENE_ID = 'copper-padlock';

/**
 * The reference preset: a copper cryptex-style padlock with seven coaxial digit
 * rings — `HHH:MM:SS` exactly. Substance materials arrive in a later bead;
 * everything else here is real, and all of it is data: ring count, layout, the
 * gear train, materials, lighting and camera framing come from this definition
 * and never from the render code.
 *
 * **The train.** The four wheels form a chain — a meshes b meshes c meshes d —
 * laid out to fill the case behind the ring stack, as in the reference image.
 * Two properties are asserted in `registry.test.ts` rather than left to
 * eyeballing:
 *
 * - meshed neighbours counter-rotate (the sign alternates along the chain), and
 * - the smaller the wheel, the faster it turns.
 *
 * Both follow from sharing one module (m = 2r/teeth = 0.055) and taking each
 * ratio from the tooth counts: `w_next = -w * teeth / teethNext`. Centre
 * distances are the sum of the two pitch radii, so the wheels visibly mesh.
 * The ratios are not the real gearing of a clock — that is the point of a
 * decorative train — but nothing about them contradicts itself.
 *
 * Everything sits at z = -1.05, behind the drums (which reach z = -1.0) and
 * clear of them, so the case reads as full rather than as rings with wheels
 * parked underneath.
 *
 * Design reference: docs/reference/preset-1-copper-padlock.png
 */
export const copperPadlockScene: SceneDefinition = {
  id: COPPER_PADLOCK_SCENE_ID,
  name: 'Copper Padlock',
  description: 'Seven-ring copper cryptex counting down to the target date.',
  mode: 'countdown',

  rings: {
    count: 7,
    radius: 1.0,
    thickness: 0.42,
    spacing: 0.5,
    axis: 'x',
    radialSegments: 64,
    slot: 'ring',
    markSlot: 'numerals',
  },

  gears: [
    // A four-wheel chain filling the case behind the drums, as in the
    // reference: the big wheels ride high enough to show above the ring stack
    // and the last one drops below it, so the movement reads as a movement
    // rather than as two slivers of tooth.
    {
      id: 'gear-a',
      slot: 'gearA',
      radius: 0.825,
      thickness: 0.13,
      teeth: 30,
      position: [-0.85, 1.25, -1.15],
      axis: [0, 0, 1],
      angularVelocity: 0.42,
    },
    // Upper right; 1.485 m from gear-a, which is 0.825 + 0.66.
    {
      id: 'gear-b',
      slot: 'gearB',
      radius: 0.66,
      thickness: 0.13,
      teeth: 24,
      position: [0.619, 1.47, -1.15],
      axis: [0, 0, 1],
      angularVelocity: -0.525,
    },
    // Right; 1.265 m from gear-b, which is 0.66 + 0.605.
    {
      id: 'gear-c',
      slot: 'gearC',
      radius: 0.605,
      thickness: 0.13,
      teeth: 22,
      position: [1.368, 0.451, -1.15],
      axis: [0, 0, 1],
      angularVelocity: 0.5727,
    },
    // Lower right; 1.2375 m from gear-c, which is 0.605 + 0.6325. The lower
    // left is left free for the escapement, which the renderer places there.
    {
      id: 'gear-d',
      slot: 'gearD',
      radius: 0.6325,
      thickness: 0.13,
      teeth: 23,
      position: [1.125, -0.763, -1.15],
      axis: [0, 0, 1],
      angularVelocity: -0.5478,
    },
  ],

  materials: {
    housing: placeholder(0x8c5a2b, 0.9, 0.35),
    bezel: placeholder(0xb87333, 0.95, 0.22),
    ring: placeholder(0xc98a4b, 0.85, 0.3),
    numerals: placeholder(0x2b1d12, 0.1, 0.7),
    gearA: placeholder(0xa9743f, 0.9, 0.32),
    gearB: placeholder(0x96652f, 0.9, 0.34),
    gearC: placeholder(0xbb8347, 0.9, 0.3),
    gearD: placeholder(0x7d5426, 0.9, 0.38),
    arbor: placeholder(0x4a4a4a, 0.95, 0.25),
    frame: placeholder(0x5c3a1a, 0.8, 0.45),
  },

  lighting: {
    background: 0x151013,
    ambient: { color: 0xffe8d0, intensity: 0.55 },
    directional: [
      { color: 0xfff1dd, intensity: 2.4, position: [4, 5, 6] },
      { color: 0x88a6ff, intensity: 0.9, position: [-5, 2, -4] },
    ],
    environment: { preset: 'none' },
    exposure: 1.05,
  },

  // Framed on the case itself: bezel to bezel and shackle to base, a little
  // above and to the right, with the open lid running off the left edge as it
  // does in the reference. The framing was widened as a stopgap while the gears
  // sat low and outside the case; now that the train fills the case behind the
  // rings it is pulled back in. `clockScene.test.ts` asserts the whole case
  // body still projects inside the frustum from here.
  camera: {
    fov: 45,
    position: [1.15, 1.0, 10.6],
    target: [0, 0.45, 0],
    near: 0.1,
    far: 100,
    minDistance: 6,
    maxDistance: 22,
    minPolarAngle: Math.PI * 0.12,
    maxPolarAngle: Math.PI * 0.86,
  },
};
