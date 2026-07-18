import { placeholder } from '../materialHelpers.js';
import type { SceneDefinition } from '../types.js';

export const SLATE_ORRERY_SCENE_ID = 'slate-orrery';

/**
 * A second preset that exists to prove the registry: different ring count,
 * spacing, materials, lighting and camera framing, driven entirely by data.
 * Adding the planned 6-ring clock-mode variant means copying this file, editing
 * the numbers and setting `mode: 'clock'` — no render-code changes.
 */
export const slateOrreryScene: SceneDefinition = {
  id: SLATE_ORRERY_SCENE_ID,
  name: 'Slate Orrery',
  description: 'Five wider rings in cool slate and steel, lit as a bright studio.',
  mode: 'countdown',

  rings: {
    count: 5,
    radius: 1.15,
    thickness: 0.34,
    spacing: 0.72,
    axis: 'x',
    radialSegments: 48,
    slot: 'ring',
    markSlot: 'numerals',
  },

  gears: [
    {
      id: 'gear-a',
      slot: 'gearA',
      radius: 0.8,
      thickness: 0.14,
      teeth: 24,
      position: [-1.1, -1.85, -0.4],
      axis: [0, 0, 1],
      angularVelocity: -0.3,
    },
    {
      id: 'gear-b',
      slot: 'gearD',
      radius: 0.5,
      thickness: 0.14,
      teeth: 15,
      position: [1.2, -1.7, -0.4],
      axis: [0, 0, 1],
      angularVelocity: 0.48,
    },
  ],

  materials: {
    housing: placeholder(0x3f4a55, 0.6, 0.5),
    bezel: placeholder(0x8f9aa6, 0.85, 0.28),
    ring: placeholder(0x6c7a89, 0.7, 0.38),
    numerals: placeholder(0xe8f0f7, 0.05, 0.6),
    gearA: placeholder(0x9aa7b4, 0.8, 0.3),
    gearB: placeholder(0x7b8794, 0.8, 0.32),
    gearC: placeholder(0x5f6b78, 0.8, 0.34),
    gearD: placeholder(0xaab6c2, 0.8, 0.26),
    arbor: placeholder(0x2f3740, 0.9, 0.2),
    frame: placeholder(0x39424c, 0.5, 0.55),
  },

  lighting: {
    background: 0x223038,
    ambient: { color: 0xdfe9f2, intensity: 1.1 },
    directional: [
      { color: 0xffffff, intensity: 2.0, position: [-4, 6, 5] },
      { color: 0xbcd4ff, intensity: 1.2, position: [5, 1, -3] },
    ],
    environment: { preset: 'none' },
    exposure: 1.0,
  },

  camera: {
    fov: 50,
    position: [0.5, 2.0, 8.0],
    target: [0, -0.2, 0],
    near: 0.1,
    far: 100,
    minDistance: 4,
    maxDistance: 16,
    minPolarAngle: Math.PI * 0.1,
    maxPolarAngle: Math.PI * 0.8,
  },
};
