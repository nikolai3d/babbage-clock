# Assets and geometry conventions

Everything the clock is made of is generated in code. There are no mesh files in
this repository and none are planned as a hard dependency. This document records
that decision, the conventions any future authored asset must follow, and the
comparison behind the numeral engraving approach.

The one class of binary asset that _is_ shipped is the HDR panoramas behind the
lighting moods, under `assets/ibl/`: five 1k Radiance files, 1.1-1.8 MB each,
all CC0 from Poly Haven. Each is lazily loaded — no mood but the one on screen
is ever fetched — and each preset folder records its own provenance and licence.
See **[lighting.md](lighting.md)** and `assets/ibl/LICENSES.md`.

## Procedural vs authored

**Decision: fully procedural for now — gears, rings and housing all generated in
code.** A stylised housing that approximates
`docs/reference/preset-1-copper-padlock.png` is accepted in exchange for the
properties procedural geometry gives us:

- **Scenes stay data.** `RingConfig` says seven rings of 1 m radius; the drum and
  its numerals are computed from that. The planned six-ring clock variant is a
  scene file, not a modelling session. A fixed mesh would quietly break that
  promise the moment a scene changed a dimension.
- **The maths is testable.** Tooth profiles, digit angle mapping and glyph
  outlines are pure functions in `src/geometry/`, unit-tested with no WebGL
  context and no binary fixtures.
- **No asset pipeline yet.** No loader, no LFS, no licensing, no review problem
  for binary diffs.

**Blender -> glTF remains the customisation route.** Authored parts can replace
procedural ones piece by piece, because every piece is already keyed by material
slot (see the contract below). The bead that adds a loader should keep the
generators as the default so a missing or slow asset degrades to something that
still renders.

The "authored asset round-trip proof" originally scoped with this work was
explicitly deferred by the owner and is not implemented here.

## Units, origin and axes

- **Units are metres.** A ring radius of `1.0` is a one-metre drum. The whole
  assembly is a few metres across; keep it that way so the camera near/far
  planes and light intensities in scene data stay meaningful.
- **Y is up. The camera looks down -Z.** The reading line of a digit ring is the
  point facing +Z.
- **Generators return geometry centred on the origin** and, where an axis is
  implied, aligned to it:
  - `createGearGeometry` — gear lies in the XZ plane and rotates about **+Y**,
    matching how `GearSpec.axis` is applied by `ClockSceneView`.
  - `createRingBodyGeometry` / `createRingNumeralsGeometry` — already aligned to
    `RingConfig.axis`; the caller only translates along that axis.
  - `createHousingParts` — case-local space: the mouth opens along **+Z**, the
    hinge is on **-X**, the shackle rises along **+Y**.
- **Rotation follows the right-hand rule.** `ringPlaneAxes(axis)` spells out the
  `(u, v)` pair for each ring axis so digit placement and ring rotation cannot
  drift apart.

## Polygon budgets

Measured on the shipped scenes (`copper-padlock`, 7 rings, 4 gears, escapement):

| Asset class         | Triangles   | Notes                                       |
| ------------------- | ----------- | ------------------------------------------- |
| Ring drum           | ~770        | one shared buffer for the whole stack       |
| Ring numerals (x10) | ~1,500      | one merged buffer, shared by every ring     |
| Gear                | ~2,600      | scales with tooth count and spoke style     |
| Housing (all parts) | ~3,500      | shell, bezel, 10 studs, lid, hinge, shackle |
| Escapement          | ~3,000      | balance, escape wheel, cock                 |
| Detent levers (x7)  | ~700        | one buffer, one InstancedMesh               |
| Arbor and bosses    | ~600        |                                             |
| **Whole scene**     | **~40,400** | copper-padlock at default parameters        |

Budget: **under 150k triangles per scene** and **under 40 draw calls**. The
copper preset currently uses 35 draw calls: 7 drums + 7 numeral meshes (each a
separate mesh only because rings rotate independently), 4 gears + 4 pins, 1
arbor, 2 bosses, 5 housing parts, 3 escapement parts and 2 instanced meshes (the
bezel studs and the detent levers). `clockScene.test.ts` asserts both budgets
for every registered scene, so a scene that blows them fails the suite rather
than the frame rate.

The detent levers are the pattern to copy for anything that repeats _and_
animates independently: one geometry, one `InstancedMesh`, per-instance matrices
rewritten each frame. Seven levers that each rock on their own ring cost one
draw call.

Two rules keep those numbers down:

- **Share geometry, not meshes.** Every ring in a stack points at the same two
  buffers.
- **Merge or instance repeats.** Ten digits become one buffer; ten screw studs
  become one `InstancedMesh`.

Anything a generator allocates must be registered with `ClockSceneView.track()`,
and anything owning a GPU buffer beyond geometry and material (i.e.
`InstancedMesh`) must be pushed to `disposables`. Scene switching is a supported
runtime action, so leaks compound.

## Material slot contract

Slots are fixed in `MATERIAL_SLOTS` (`src/scene/types.ts`). Geometry never
creates a material; it declares which slot it belongs to and the caller binds it.

| Slot            | Used by                                                        |
| --------------- | -------------------------------------------------------------- |
| `housing`       | case shell, ring-stack bearing bosses                          |
| `bezel`         | bezel ring, screw studs, balance wheel                         |
| `frame`         | lid, hinge, shackle, balance cock                              |
| `ring`          | digit drums (`RingConfig.slot`)                                |
| `numerals`      | engraved digits (`RingConfig.markSlot`)                        |
| `gearA`–`gearD` | gear wheels per `GearSpec.slot`; `gearD` also the escape wheel |
| `arbor`         | ring shaft, gear pins, detent levers                           |

**Texture coordinates.** Every generator writes UVs on one convention: **one UV
unit is one metre of real surface**, so a material's `tiling` means the same
thing on the drums, the case, a gear face and the engraved numerals. The
projections that get there — cylindrical for revolved parts, planar for flat
discs, box projection for merged solids — live in `src/render/geometry/uv.ts`,
and the numerals' cylindrical mapping is computed in the same pass that bends
them onto the drum. Details and the verification procedure:
**[materials.md](materials.md)**.

**For any future authored glTF:** name each mesh or material after the slot it
targets (`housing`, `bezel`, …). A loader can then bind an imported part to the
scene's existing `MaterialSlotMap` without touching a single scene file, and an
authored part becomes a drop-in replacement for its procedural equivalent.
Authored parts must also follow the units, origin and axis conventions above:
metres, centred, and aligned to the axis the generator they replace uses.

## Numeral engraving: the comparison

The requirement: ten digits 36 degrees apart, legible at the default camera
distance, upright at the reading line, with neighbours partly visible above and
below like a combination padlock — using only the placeholder materials that
exist today.

### (a) Geometry engraving — boolean or displacement into the drum

Crisp from every angle and physically honest: a real engraved drum. Rejected.
A CSG boolean means a new dependency (`three-bvh-csg`) and a per-ring boolean of
ten glyphs at scene-build time, which is the slowest thing in the frame budget on
a scene switch. Displacement instead needs dense tessellation everywhere to
resolve a stroke that covers a few percent of the surface. Both spend a lot to
win detail that is invisible at the framing this clock is shot at.

### (b) Normal + albedo texture atlas wrapped per ring

Cheapest to render and the standard answer. Rejected on two counts. First, at
the time it depended on textures that did not exist, and an atlas drawn to a
canvas at runtime would have made the entire numeral path untestable in the
DOM-free Node unit environment. (The PBR pipeline has since landed, so this
argument is now only historical — but the geometry is built and paid for, and
the numerals carry correct cylindrical UVs, so a texture can be laid over them
if a later bead wants one.) Second, resolution: with ten digits around a
1 m drum, keeping the reading digit crisp under orbit needs a large atlas per
ring size, and a normal map alone would make the digits vanish at grazing angles
where the padlock reads best.

### (c) Extruded glyph geometry — **chosen**

Digits are authored as centre-line strokes, offset into filled outlines
(`src/geometry/strokes.ts`), extruded, and bent onto the drum so they stand
proud of the surface with their base sunk into it.

Why it wins here:

- **No assets and no dependencies.** No font file, no texture, no CSG library —
  which also means no dependency on the PBR bead.
- **Correct with placeholder materials.** The digits are lit geometry, so they
  read as relief under the existing lights; they do not need a texture to exist.
- **Pure and testable.** Glyph outlines and digit angles are plain maths;
  legibility constraints are asserted, not eyeballed.
- **Cheap enough.** ~1,500 triangles per ring, merged into one buffer, shared
  across the whole stack.
- **Parametric.** `strokeWidth` reweights every digit at once, and the digit set
  is a parameter — a ring is not restricted to 0-9.

The trade: raised numerals, not sunk. At the default framing that difference is
not visible, and the intent is preserved (dark digits standing off a copper
drum). If a later bead wants true engraving, the same outlines feed a boolean
without changing anything above them.

### How legibility was verified

- Glyphs were rasterised straight from their outlines and inspected at
  160 px/em and at the size a digit actually occupies on screen, then adjusted:
  the `3` became two separate bowls after its miter join folded into a visible
  notch, and the `5`'s bowl entry angle was moved to close a hairline nick.
- The full assembled scene was software-rendered offline (both presets, scene
  camera, z-buffered) to confirm the digit on the reading line is upright and
  readable and that the neighbours above and below are partly visible.
- Two properties are pinned by unit tests rather than by eye:
  `digitAngle(d) + ringAngleForDigit(d)` must land on the reading angle for
  every digit and every axis, and `numeralLayout` must keep glyph height below
  the arc available per digit and glyph width inside the drum.

Sizing rule: glyph height is the smaller of 62% of the arc per digit and what
fits across the drum's width. Both bounds scale with `RingConfig`, so a ring size
never seen before still gets numerals that fit — the layout validator rejects it
if they would not.
