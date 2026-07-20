import { pbr } from '../../materials/looks.js';
import type { SceneDefinition } from '../types.js';

export const BABBAGE_ENGINE_SCENE_ID = 'babbage-engine';

/**
 * The authored-geometry preset: the same seven-ring `HHH:MM:SS` cryptex as
 * `copper-padlock`, but every part is drawn from a Blender-authored model
 * (`public/assets/models/babbage-engine.glb`) instead of the procedural
 * generators, and the whole clock is seated on a table with a back panel.
 *
 * This is the scene the authored-geometry epic delivers (see
 * `docs/authored-geometry.md`). What distinguishes it from copper: `assets`, the
 * static `table` set-dressing, and — instead of the procedural round padlock case
 * (`housingStyle: 'none'`) — an ornate rectangular brass frame authored as the
 * `casing` role. The ring layout and gear train are identical to copper because
 * the Blender parts were modelled to *these* dimensions (drum radius 1.0, gears
 * at the `GearSpec` radii, the frame sized to enclose the whole mechanism). The
 * engine still positions and animates every part from this data; the model only
 * supplies the shape. A part missing from the model degrades to its generator
 * (the casing has none — it simply is not drawn if absent), so the clock still
 * renders.
 *
 * Material bindings are copper's, reused — except `casing`, which is on its own
 * distinct slot for a dedicated material later. Swapping looks touches only this map.
 */
export const babbageEngineScene: SceneDefinition = {
  id: BABBAGE_ENGINE_SCENE_ID,
  name: 'Babbage Engine',
  description: 'Seven-ring cryptex authored in Blender, seated on its table.',
  mode: 'countdown',

  // The authored model. Named parts override the generators; anything the model
  // does not carry falls back to the generator (see docs/authored-geometry.md).
  assets: { source: 'assets/models/babbage-engine.glb' },

  // No procedural padlock case: this scene wears the authored ornate rectangular
  // frame (`casing` role in the model), added by `buildCasing`. See HousingStyle.
  housingStyle: 'none',

  // Identical to copper-padlock: the Blender drum/numerals/case/escapement were
  // all modelled to the dimensions this configuration produces.
  rings: {
    count: 7,
    radius: 1.0,
    thickness: 0.42,
    spacing: 0.43,
    axis: 'x',
    radialSegments: 64,
    slot: 'ring',
    markSlot: 'numerals',
    separators: [{ afterRing: 3 }, { afterRing: 5 }],
  },

  // The four-wheel chain, unchanged from copper: the authored wheels were
  // modelled at these radii and tooth counts, so they drop into the same slots.
  gears: [
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

  // Copper's slot bindings, reused verbatim: materials are a later epic. The
  // new static roles (table -> housing, env-* -> frame) fall through to these.
  materials: {
    housing: pbr('rusty-copper', { roughness: 1.1 }),
    bezel: pbr('rusty-copper', { tiling: [1.2, 1.2], roughness: 0.8 }),
    ring: pbr('rusty-copper', { tiling: [3.2, 3.2], roughness: 0.5 }),
    numerals: pbr('polished-brass'),
    gearA: pbr('rusty-copper', { tiling: [1.2, 1.2] }),
    gearB: pbr('blued-steel'),
    gearC: pbr('rusty-copper', { tiling: [1.4, 1.4], roughness: 0.9 }),
    gearD: pbr('blued-steel', { roughness: 1.2 }),
    arbor: pbr('blued-steel', { tiling: [2, 2] }),
    frame: pbr('rusty-copper', { tiling: [0.7, 0.7], roughness: 1.25 }),
    // The ornate rectangular enclosure, on its own distinct slot: brass rather
    // than the case's rusty copper, so it reads as its own piece. A dedicated
    // authored material is expected to replace this later — swap this line only.
    casing: pbr('polished-brass', { roughness: 0.7 }),
  },

  lighting: {
    background: 0x151013,
    ambient: { color: 0xffe8d0, intensity: 0.55 },
    directional: [
      { color: 0xfff1dd, intensity: 2.4, position: [4, 5, 6] },
      { color: 0x88a6ff, intensity: 0.9, position: [-5, 2, -4] },
    ],
    environment: { preset: 'steampunk-workshop', showAsBackground: false },
    exposure: 1.05,
  },

  // Pulled back and lowered from copper's framing so the table the clock sits on
  // and the panel behind it read as a set, not just the case. The case body
  // still projects well inside this frustum (it did from copper's tighter one).
  camera: {
    fov: 45,
    position: [1.4, 1.6, 12.8],
    target: [0, -0.15, 0],
    near: 0.1,
    far: 100,
    minDistance: 6,
    maxDistance: 24,
    minPolarAngle: Math.PI * 0.12,
    maxPolarAngle: Math.PI * 0.86,
  },
};
