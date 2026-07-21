# Authored geometry: the contract

Everything the clock is made of is generated in code today (see
**[assets.md](assets.md)**). This document is the contract for the alternative
path: **quality geometry authored in Blender**, imported as glTF, and animated by
the _existing_ engine — `ClockSceneView` reads a `Mechanism` sample and writes the
same transforms whether a part came from a generator or from a `.glb`.

It is the shared spec the asset loader and every modelling task depend on. Get a
part's pivot, axis, name or scale wrong and it will not drop into the transform slot
the generator occupied, and the animation — which is unchanged — will move the wrong
thing.

Scope of this document is **geometry only**. Materials are resolved exactly as they
are now, through the scene's `MaterialSlotMap`; nothing here authors a texture.

## The one idea

An authored part is a drop-in replacement for a procedural one. The generators in
`src/render/geometry/` return a `BufferGeometry` **centred on its own pivot and
aligned to a fixed axis**; `ClockSceneView` wraps each in a group and applies the
_position and rotation_ that come from scene data (`RingConfig`, `GearSpec`, the case
metrics). An authored mesh must arrive in that same local frame. Then the loader
hands `ClockSceneView` the authored geometry instead of the generator's output, the
group transform is identical, and every moving part animates by construction.

So: **do not bake a part's placement into its mesh.** A ring drum is modelled once,
centred, and the engine positions the seven copies along the axis. A gear is modelled
at the origin, and the engine moves it to its `GearSpec.position`. The mesh carries
shape; the scene carries placement.

## 1. Coordinate mapping (Blender Z-up → three.js Y-up)

The glTF exporter is run with `export_yup=True`, so `GLTFLoader` receives a Y-up
scene. Blender is Z-up. The exporter therefore rotates the data, and the mapping an
author must hold in their head is:

| Blender axis | three.js axis |
| ------------ | ------------- |
| +X           | +X            |
| +Y           | −Z            |
| +Z           | +Y            |

Equivalently, `three (x, y, z)` is authored in Blender at `(x, −z, y)`.

The engine's conventions (from **[assets.md](assets.md)**) are stated in three.js
space: **metres**; **three +Y is up**; the camera looks down **−Z**; the digit on the
reading line faces **+Z**. Blender's unit system must be Metric / Meters with
`scale_length = 1.0` (verified default on the project's Blender 5.2 LTS), so one
Blender metre is one engine metre with no scaling on export.

## 2. Per-role orientation and pivot

Author each part in Blender so that, _after_ the y-up conversion, it matches the
three.js-space target the generator produces. The table gives both.

| Role                                                             | three.js-space target                                                                            | Author in Blender as                                            | Pivot / origin               |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ | --------------------------------------------------------------- | ---------------------------- |
| `gearA`–`gearD`, `escape-wheel`, `balance`                       | lies in the XZ plane, spins about **+Y**                                                         | flat in the **Blender XY plane**, thickness along **Blender Z** | wheel centre at the origin   |
| `ring-body` (the drum / "coil")                                  | axis along `RingConfig.axis` (copper preset: **x**)                                              | revolve the profile about **Blender X** for axis `x`            | drum centre at the origin    |
| `numerals`                                                       | co-rotates with its ring; digit `d` sits at `π/2 + d·36°` in the (y, z) plane at the drum radius | see §4                                                          | ring axis through the origin |
| `case-shell`, `bezel`, `lid`, `hinge`, `shackle`, `stud`, `boss` | mouth opens **+Z**, hinge on **−X**, shackle rises **+Y**                                        | mouth faces **Blender −Y**, hinge on **−X**, shackle up **+Z**  | case centre at the origin    |
| `arbor`, `gear-pin`, `detent-lever`                              | along the ring/gear axis it serves                                                               | as the part it serves                                           | at the rotation / rock pivot |
| `table`, `env-*`                                                 | ground below the clock (−Y is down)                                                              | ground plane in **Blender XY**, at **−Z**                       | scene origin, under the case |

Why the gear lands right: three +Y (its spin axis) equals Blender +Z, so a wheel built
flat on the Blender floor with its thickness pointing up spins about the correct axis
with no rotation baked in. This is also the natural way to model a gear, which is the
point of choosing the convention.

Why the drum uses Blender X: the copper preset lays its rings along `axis: 'x'`, and
three +X equals Blender +X, so the drum's revolution axis is Blender X. A scene using
a different ring axis would author the drum about the matching Blender axis; the
`babbage-engine` scene fixes `axis: 'x'` to match the delivered model.

The `detent-lever` is the one part whose lever-local frame is stated in three-space,
so mind the conversion: `createDetentLeverGeometry` builds it hanging along three
**−Y** with its pivot axle along three X. Three −Y is Blender **−Z** (three +Y =
Blender +Z), so author the lever **hanging along Blender −Z**, pivot at the origin,
thin along Blender X — not along Blender −Y. The engine then rotates that frame onto
the ring axis and rocks it about the pivot.

## 3. Naming → role and material slot

**An object's name is its role key.** The loader indexes every mesh in the `.glb` by
object name and looks it up by role. The role vocabulary:

```
gearA gearB gearC gearD escape-wheel balance balance-cock
ring-body numerals
case-shell bezel lid hinge shackle stud boss
arbor gear-pin detent-lever
table env-<name>
```

The **material slot** is _derived from the role_, so a clean mesh name is all the
model needs to carry — no per-object custom properties. The mapping reuses the fixed
`MATERIAL_SLOTS` (`src/scene/types.ts`):

| Role                                      | Material slot                                                                |
| ----------------------------------------- | ---------------------------------------------------------------------------- |
| `case-shell`, `boss`                      | `housing`                                                                    |
| `bezel`, `stud`, `balance`                | `bezel`                                                                      |
| `lid`, `hinge`, `shackle`, `balance-cock` | `frame`                                                                      |
| `ring-body`                               | `ring`                                                                       |
| `numerals`                                | `numerals`                                                                   |
| `gearA`–`gearD`                           | `gearA`–`gearD`                                                              |
| `escape-wheel`                            | `gearD`                                                                      |
| `arbor`, `gear-pin`, `detent-lever`       | `arbor`                                                                      |
| `table`, `env-*`                          | `housing` / `frame` (placeholder; a dedicated slot is a materials follow-up) |

This is the same slot contract authored glTF was always expected to honour
(assets.md, "Material slot contract"); it is written out here as an explicit table so
the loader can implement it as a lookup.

## 4. Numeral placement — must reproduce `digitAngle`

The numerals are one merged mesh that rotates _with_ its ring. If a digit is not at
the exact angle the mechanism rotates to, the wrong number shows on the reading line.
The angles are not a matter of taste — they come from `src/geometry/ringLayout.ts`.

For ring axis `x`: the reading line is at `π/2`, the step is `36°` (`2π/10`), and the
in-plane axes are (u, v) = (y, z). Digit `d` is engraved at

```
θ_d = π/2 + d · (2π/10)
```

and the ring is rotated by `−d · 36°` to bring digit `d` to the reading line
(`ringAngleForDigit`). At rest, digit `0` faces three +Z — the reading line — which
you can check: `θ_0 = π/2`, giving three `(0, 0, R)`.

In **Blender**, after the three→Blender conversion, digit `d`'s placement and local
frame are:

```python
import math
from mathutils import Matrix, Vector

R = 1.0          # drum surface radius (metres)
along_x = 0.0    # digit centre along the drum width

def digit_transform(d):
    theta = math.pi / 2 + d * (2 * math.pi / 10)
    ct, st = math.cos(theta), math.sin(theta)
    loc    = Vector((along_x, -R * st,  R * ct))   # radial position, three→Blender
    x_axis = Vector(( 1.0, 0.0, 0.0))              # glyph width  → ring axis
    y_axis = Vector(( 0.0, ct,  st))               # glyph height → tangent (digits scroll past)
    z_axis = Vector(( 0.0, -st,  ct))              # glyph relief → radial, points outward
    rot = Matrix((x_axis, y_axis, z_axis)).transposed().to_4x4()
    return Matrix.Translation(loc) @ rot
```

`Matrix((x,y,z)).transposed()` puts the three axes in the columns, so the rotation
maps glyph-local X/Y/Z onto `x_axis`/`y_axis`/`z_axis`. Relief stands proud of `R`
along the outward radial. The signs are dictated by the engine's bend in
`engraveGlyphOntoDrum` (`theta = angle − height/radius`, `y = r·cosθ`, `z = r·sinθ`):
the height axis is `(0, cosθ, sinθ)`, which makes the frame right-handed and puts
digit `0` **upright** at the reading line (its top toward Blender +Z). Negating it —
as an earlier draft of this snippet did — flips the digits upside-down and mirrors
them. The verification for the numerals task is to import the drum and numerals
together and confirm rotating the pair by `−d·36°` about X reads digit `d` upright
(spot-check `d = 0, 3, 7`).

Size the glyphs to the engine's `numeralLayout`, not to a fixed guess: for the copper
ring (`radius 1.0`, `thickness 0.42`) that is a cap height of about **0.39 m**
(`heightFraction 0.62 × arcPerDigit 0.628`), which is what keeps neighbouring digits
partly visible above and below the reading line.

The procedural numerals (`createRingNumeralsGeometry`) remain the fallback and the
authority on these angles; authored numerals reproduce them, they do not redefine
them.

## 5. Budgets

The whole-scene budgets from **[assets.md](assets.md)** still apply and are asserted
by `clockScene.test.ts` for every registered scene:

- **Under 150k triangles per scene.**
- **Under 40 draw calls.**

Author to roughly the current per-part triangle counts, with headroom:

| Part                                     | Target triangles |
| ---------------------------------------- | ---------------- |
| `ring-body` drum                         | ~800 (≤ 1,000)   |
| `numerals` (10 digits, merged)           | ~1,500 (≤ 1,800) |
| gear                                     | ~2,600 (≤ 3,000) |
| housing (all parts)                      | ~3,500 (≤ 4,000) |
| escapement (balance, escape wheel, cock) | ~3,000           |
| `detent-lever`                           | ~120             |
| `env-gearbox-frame` (merged, one draw)   | ~8,000           |

Gears sharing a slot render as **one `InstancedMesh` per wheel shape** — the
`babbage-engine` wreath is twelve wheels wearing four shapes, so its whole train
is four wheel draw calls plus one for the instanced pins. A wheel's triangles
are paid once per _instance_ against the 150k budget, but only once per _shape_
in the delivered GLB.

Two rules from assets.md carry over and the loader relies on them:

- **Share geometry, not meshes.** One `ring-body` mesh is reused by every ring in the
  stack; the engine makes N meshes pointing at the one buffer.
- **Merge or instance repeats.** `stud`, `gear-pin` and `detent-lever` are authored
  once and instanced by the engine (`InstancedMesh`), so ten studs and seven levers
  are one draw call each.

Deliver **one** mesh per shared/instanced role. Do not pre-duplicate a drum per ring
or a stud per boss — that defeats the sharing the budget depends on.

## 6. glTF export settings

Validated against Blender 5.2 LTS:

```python
bpy.ops.export_scene.gltf(
    filepath="…/part.glb",
    export_format="GLB",
    use_selection=True,     # export only the roles you selected
    export_apply=True,      # bake modifiers; freeze the mesh as authored
    export_yup=True,        # Z-up → Y-up (see §1)
    export_normals=True,
)
```

Geometry only — no materials or textures are exported (the engine binds slots). Object
names must survive the export (they carry the roles). **Draco is available** in this
Blender but is left **off** initially, to keep the three.js load path free of
`DRACOLoader`; the export task revisits it only if the delivered GLB grows past a few
hundred KB, in which case the loader wires `DRACOLoader` and the decoder ships under
`public/` the way `public/basis/` already does for KTX2.

## 7. File layout

- **Blender sources:** `/Users/nikolai/dev/blender-local-mcp/*.blend` — the working
  files, **not** checked into this repository. The gearbox parts come from
  **`cog-library.blend`** (26 reusable cogs in the `cogs` collection, 8 mounting
  fixtures in `fixtures`; every part flat in Blender XY, spin about +Z, origin at
  the wheel centre). Its `assembly` collection is the assembled 12-wheel gearbox
  showpiece; **`babbage-engine.blend`** carries the casing-fitted variant that the
  delivered model is exported from (the shipped wheel shapes decimated to budget,
  the fixtures merged into `env-gearbox-frame`, and the pre-gearbox wheels parked
  in an excluded `archive` collection).
- **Delivered model:** `public/assets/models/babbage-engine.glb` — checked in,
  geometry only. It is fetched at runtime
  and joined onto `import.meta.env.BASE_URL` the same way material folders are (see
  `src/materials/paths.ts`), so a sub-path deployment resolves it correctly. With
  the gearbox aboard it sits at ~1.7 MB uncompressed — past §6's "few hundred KB"
  compression threshold; wiring Draco/meshopt is a filed follow-up, not a blocker.

A scene opts into authored geometry by carrying an `assets` reference to this model
(`SceneDefinition.assets`). Scenes without one are unchanged: they render from the
generators, which remain the default and the fallback. A part that is missing from
the model, or a model that fails to load, degrades to the generator — a scene never
fails to render because a `.glb` is absent.
