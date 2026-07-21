import { pbr } from '../../materials/looks.js';
import type { SceneDefinition } from '../types.js';

export const BABBAGE_ENGINE_SCENE_ID = 'babbage-engine';

// Teeth·radians per drive-second through the front chain. Every wheel's ω is an
// exact ratio of this because the drive phase grows unboundedly, so any rounded
// |ω|·teeth mismatch accumulates into tooth-clash drift between meshed wheels.
const TOOTH_RATE = 25.2;

/**
 * The authored-geometry preset: the same seven-ring `HHH:MM:SS` cryptex as
 * `copper-padlock`, but every part is drawn from a Blender-authored model
 * (`public/assets/models/babbage-engine.glb`) instead of the procedural
 * generators, and the whole clock is seated on a table with a back panel.
 *
 * This is the scene the authored-geometry epic delivers (see
 * `docs/authored-geometry.md`). What distinguishes it from copper: `assets`, the
 * static `table` set-dressing, the twelve-wheel gearbox wreath, and — instead of
 * the procedural round padlock case (`housingStyle: 'none'`) — an ornate
 * rectangular brass frame authored as the `casing` role. The ring layout is
 * identical to copper because the Blender drum/numerals were modelled to these
 * dimensions (drum radius 1.0); the train is this scene's own: twelve wheels
 * drawn from the cog-library palette, arranged as a wreath around the drum
 * window, mounted on the static `env-gearbox-frame` (plates, pillars, bridges,
 * arbors, feet) that ships in the same model. The engine still positions and
 * animates every part from this data; the model only supplies the shape. A part
 * missing from the model degrades to its generator (the casing and frame have
 * none — they simply are not drawn if absent), so the clock still renders.
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

  // The twelve-wheel gearbox wreath: four wheel shapes from the cog-library
  // palette (60T master-6spoke, 48T rosette-pierced, 44T slots-kidney, 46T
  // curved-5spoke), three instances each, module 0.020 — pitch radius is
  // 0.010·teeth, and meshing neighbours sit at exactly the sum of their pitch
  // radii, so the teeth genuinely interlock. Ten wheels ring the drum window
  // in one chain at z=−1.13 (left column → top arc → right column → bottom
  // row, ending clear of the escapement), speeds alternating sign with
  // |ω| = TOOTH_RATE/teeth, so the whole front chain conserves |ω|·teeth =
  // 25.2 exactly. `gear-k` shares gear-a's arbor in the back plane (same
  // position and ω — a compound arbor), and its stage drives `gear-l` behind
  // the balance, which is why those two break the front chain's 25.2 rule
  // (their mesh conserves 25.2·46/44). `phase` carries the tooth interleave,
  // which must ride here because instances share one wheel geometry. Layout
  // solved against the measured casing interior (scratchpad gear_layout.py,
  // bead babbage-clock-zqq); wheels sharing a slot render as one InstancedMesh.
  gears: [
    {
      id: 'gear-a',
      slot: 'gearC',
      radius: 0.44,
      thickness: 0.093,
      teeth: 44,
      position: [-1.5557, -0.2636, -1.13],
      axis: [0, 0, 1],
      angularVelocity: TOOTH_RATE / 44,
      phase: 0,
      spokeStyle: 'crescent',
    },
    {
      id: 'gear-b',
      slot: 'gearB',
      radius: 0.48,
      thickness: 0.087,
      teeth: 48,
      position: [-1.8069, 0.6215, -1.13],
      axis: [0, 0, 1],
      angularVelocity: -TOOTH_RATE / 48,
      phase: 0.0718,
      spokeStyle: 'solid',
    },
    {
      id: 'gear-c',
      slot: 'gearA',
      radius: 0.6,
      thickness: 0.11,
      teeth: 60,
      position: [-1.4137, 1.6274, -1.13],
      axis: [0, 0, 1],
      angularVelocity: TOOTH_RATE / 60,
      phase: 0.0573,
      spokeStyle: 'spoke6',
    },
    {
      id: 'gear-d',
      slot: 'gearB',
      radius: 0.48,
      thickness: 0.087,
      teeth: 48,
      position: [-0.3443, 1.7781, -1.13],
      axis: [0, 0, 1],
      angularVelocity: -TOOTH_RATE / 48,
      phase: 0.047,
      spokeStyle: 'solid',
    },
    {
      id: 'gear-e',
      slot: 'gearA',
      radius: 0.6,
      thickness: 0.11,
      teeth: 60,
      position: [0.7237, 1.6173, -1.13],
      axis: [0, 0, 1],
      angularVelocity: TOOTH_RATE / 60,
      phase: 0.06,
      spokeStyle: 'spoke6',
    },
    {
      id: 'gear-f',
      slot: 'gearB',
      radius: 0.48,
      thickness: 0.087,
      teeth: 48,
      position: [1.7496, 1.2798, -1.13],
      axis: [0, 0, 1],
      angularVelocity: -TOOTH_RATE / 48,
      phase: 0.0609,
      spokeStyle: 'solid',
    },
    {
      id: 'gear-g',
      slot: 'gearC',
      radius: 0.44,
      thickness: 0.093,
      teeth: 44,
      position: [1.8499, 0.3653, -1.13],
      axis: [0, 0, 1],
      angularVelocity: TOOTH_RATE / 44,
      phase: 0.0904,
      spokeStyle: 'crescent',
    },
    {
      id: 'gear-h',
      slot: 'gearD',
      radius: 0.46,
      thickness: 0.091,
      teeth: 46,
      position: [1.7247, -0.5259, -1.13],
      axis: [0, 0, 1],
      angularVelocity: -TOOTH_RATE / 46,
      phase: 0.0501,
      spokeStyle: 'spoke5',
    },
    {
      id: 'gear-i',
      slot: 'gearC',
      radius: 0.44,
      thickness: 0.093,
      teeth: 44,
      position: [1.1097, -1.183, -1.13],
      axis: [0, 0, 1],
      angularVelocity: TOOTH_RATE / 44,
      phase: 0.1223,
      spokeStyle: 'crescent',
    },
    {
      id: 'gear-j',
      slot: 'gearD',
      radius: 0.46,
      thickness: 0.091,
      teeth: 46,
      position: [0.2149, -1.2799, -1.13],
      axis: [0, 0, 1],
      angularVelocity: -TOOTH_RATE / 46,
      phase: 0.0258,
      spokeStyle: 'spoke5',
    },
    {
      id: 'gear-k',
      slot: 'gearD',
      radius: 0.46,
      thickness: 0.091,
      teeth: 46,
      position: [-1.5557, -0.2636, -1.39],
      axis: [0, 0, 1],
      // Rides gear-a's arbor (a compound pair), so its ω is gear-a's exactly —
      // TOOTH_RATE/44 for a 46T wheel, not TOOTH_RATE/46.
      angularVelocity: TOOTH_RATE / 44,
      phase: 0,
      spokeStyle: 'spoke5',
    },
    {
      id: 'gear-l',
      slot: 'gearA',
      radius: 0.6,
      thickness: 0.11,
      teeth: 60,
      position: [-0.5954, -0.7123, -1.39],
      axis: [0, 0, 1],
      // Meshes 46T gear-k, so |ω_l|·60 = |ω_k|·46 exactly.
      angularVelocity: (-TOOTH_RATE * 46) / (44 * 60),
      phase: 0.0131,
      spokeStyle: 'spoke6',
    },
  ],

  // Pinned where the four-wheel train's derived placement put it: the case
  // metrics derive clearance from gear extents, and the wreath reaches further
  // out than the old cluster did, so leaving this to derivation would inflate
  // and displace the escapement (and collide it with the bottom-row wheels).
  // The authored balance/escape-wheel meshes are fixed-size, so pinning the
  // position keeps the escapement exactly where it renders today.
  escapement: {
    position: [-1.3639, -1.3683, -1.15],
    escapeWheelOffset: [0.78, 0.3171, 0],
  },

  // Copper's slot bindings, mostly reused: materials are a later epic. The
  // new static roles (table -> housing, env-* -> frame) fall through to these.
  materials: {
    housing: pbr('rusty-copper', { roughness: 1.1 }),
    bezel: pbr('rusty-copper', { tiling: [1.2, 1.2], roughness: 0.8 }),
    ring: pbr('rusty-copper', { tiling: [3.2, 3.2], roughness: 0.5 }),
    numerals: pbr('polished-brass'),
    gearA: pbr('rusty-copper', { tiling: [1.2, 1.2] }),
    // Brass, not copper's blued steel: the three rosette wheels sit across the
    // top of the window against the workshop backdrop, and in blued steel the
    // whole band reads as silhouettes under this scene's dim rig.
    gearB: pbr('polished-brass', { roughness: 0.8 }),
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
