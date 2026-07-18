import { placeholder } from '../materialHelpers.js';
import type { SceneDefinition } from '../types.js';

export const COPPER_PADLOCK_SCENE_ID = 'copper-padlock';

/**
 * The reference preset: a copper cryptex-style padlock with seven coaxial digit
 * rings. Geometry here is a deliberate stub — the real mechanism, numerals and
 * Substance materials arrive in later beads. What is real is the wiring: ring
 * count, layout, materials, lighting and camera framing all come from this
 * definition, never from the render code.
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
    {
      id: 'gear-a',
      slot: 'gearA',
      radius: 0.62,
      thickness: 0.12,
      teeth: 18,
      position: [-1.35, -1.45, 0.35],
      axis: [0, 0, 1],
      angularVelocity: 0.45,
    },
    {
      id: 'gear-b',
      slot: 'gearB',
      radius: 0.44,
      thickness: 0.12,
      teeth: 13,
      position: [0.15, -1.6, 0.35],
      axis: [0, 0, 1],
      angularVelocity: -0.62,
    },
    {
      id: 'gear-c',
      slot: 'gearC',
      radius: 0.34,
      thickness: 0.1,
      teeth: 10,
      position: [1.45, -1.35, 0.35],
      axis: [0, 0, 1],
      angularVelocity: 0.81,
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

  camera: {
    fov: 45,
    position: [0, 1.6, 10.5],
    target: [0, 0.2, 0],
    near: 0.1,
    far: 100,
    minDistance: 5,
    maxDistance: 20,
    minPolarAngle: Math.PI * 0.12,
    maxPolarAngle: Math.PI * 0.86,
  },
};
