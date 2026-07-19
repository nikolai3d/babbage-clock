import { pbr } from '../../materials/looks.js';
import type { SceneDefinition } from '../types.js';

export const COPPER_PADLOCK_SCENE_ID = 'copper-padlock';

/**
 * The reference preset: a copper cryptex-style padlock with seven coaxial digit
 * rings — `HHH:MM:SS` exactly. All of it is data: ring count, layout, the gear
 * train, materials, lighting and camera framing come from this definition and
 * never from the render code.
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
    // Tighter than a single seven-ring stack would need: the two colon drums
    // add two positions, and 0.43 keeps the nine-position `HHH:MM:SS` stack
    // barely wider than the old seven-ring one — narrow enough that the whole
    // readout still fits a portrait phone without cropping (see the framing note
    // in mobile.spec.ts), while `spacing > thickness` keeps the drums clear.
    spacing: 0.43,
    axis: 'x',
    radialSegments: 64,
    slot: 'ring',
    markSlot: 'numerals',
    // The readout is `HHH:MM:SS`; static colon drums mark the two group
    // boundaries — after the three hours rings and after the two minutes rings.
    // They render like the digit drums (same `ring`/`numerals` slots) but never
    // rotate and read no time component, so the seven digit rings still map to
    // hours, minutes and seconds exactly as before.
    separators: [{ afterRing: 3 }, { afterRing: 5 }],
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

  // A look, expressed as data: every slot names a material folder under
  // `public/assets/materials/`, and the renderer loads it. This is the
  // validation that the slot abstraction holds — swapping the whole clock from
  // untextured placeholders to authored PBR sets touched no render code and no
  // geometry, only these ten lines.
  //
  // `numerals` is a folder with no textures at all, only manifest scalars; the
  // engraved digits want a flat lacquer, and proving that path renders without
  // a single request is worth as much as proving the textured one does.
  //
  // The per-slot `roughness` and `metalness` here are multipliers over the
  // authored maps, not replacements — see `PbrMaterialBinding`.
  materials: {
    housing: pbr('rusty-copper', { roughness: 1.1 }),
    bezel: pbr('rusty-copper', { tiling: [1.2, 1.2], roughness: 0.8 }),
    // The drums are the reading surface: tighter tiling shrinks the rust
    // spotting to flecks and the lower roughness reads as metal polished by
    // the detents' contact — which is also what keeps the numerals legible
    // against it. The housing keeps the full-scale weathering.
    ring: pbr('rusty-copper', { tiling: [3.2, 3.2], roughness: 0.5 }),
    // Bright raised digits on the weathered drum — dark enamel vanished
    // tone-on-tone once the drums carried real rust.
    numerals: pbr('polished-brass'),
    gearA: pbr('rusty-copper', { tiling: [1.2, 1.2] }),
    gearB: pbr('blued-steel'),
    gearC: pbr('rusty-copper', { tiling: [1.4, 1.4], roughness: 0.9 }),
    gearD: pbr('blued-steel', { roughness: 1.2 }),
    arbor: pbr('blued-steel', { tiling: [2, 2] }),
    frame: pbr('rusty-copper', { tiling: [0.7, 0.7], roughness: 1.25 }),
  },

  lighting: {
    background: 0x151013,
    ambient: { color: 0xffe8d0, intensity: 0.55 },
    directional: [
      { color: 0xfff1dd, intensity: 2.4, position: [4, 5, 6] },
      { color: 0x88a6ff, intensity: 0.9, position: [-5, 2, -4] },
    ],
    // The default mood. `showAsBackground: false` is the point of the flag:
    // the workshop panorama lights the copper, but the viewer keeps looking at
    // this preset's dark vignette rather than a photograph of a fireplace.
    // The ambient and directional lights above are the no-environment
    // fallback — a mood scales them to its own `sceneLightScale`.
    environment: { preset: 'steampunk-workshop', showAsBackground: false },
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
