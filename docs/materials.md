# Materials

How a material authored in Adobe Substance 3D Sampler gets onto the clock.

The short version: export a baked texture set, drop the folder into
`public/assets/materials/<name>/`, add a `material.json` beside the maps, and
name the folder from a scene's material slots. **No code changes.**

---

## 1. What the pipeline takes, and what it does not

| Format                           | Supported | Why                                                                                                                           |
| -------------------------------- | --------- | ----------------------------------------------------------------------------------------------------------------------------- |
| **Baked texture set** + manifest | **Yes**   | The canonical interchange. Close to Sampler's PBR-texture-set export verbatim.                                                |
| `.sbsar`                         | No        | Procedural: needs the Substance engine to evaluate. There is no browser runtime for it, and shipping one is not on the table. |
| `.sbs`                           | No        | Sampler's own project format. Author in it, export out of it.                                                                 |
| glTF material import             | Not yet   | See [Follow-ups](#follow-ups).                                                                                                |
| MaterialX                        | Not yet   | Ditto — experimental in three.js.                                                                                             |

The convention throughout is **glTF metallic-roughness**, which is what
Sampler's glTF export template writes and what three.js samples natively. Every
decision below follows from picking that and not deviating from it.

---

## 2. Exporting from Substance 3D Sampler

In Sampler: **File -> Export as -> Bitmaps** (or the export button on the
material in your library).

| Setting             | Value                                                                     |
| ------------------- | ------------------------------------------------------------------------- |
| **Export template** | `PBR Metallic Roughness` (the glTF preset)                                |
| **Format**          | PNG (16-bit is fine — it is read as 8) or JPG for base colour             |
| **Resolution**      | 2048 x 2048 or smaller. See [texture size](#7-texture-size-and-delivery). |
| **Normal format**   | **OpenGL** (Y+). If you can only export DirectX, say so in the manifest.  |
| **Channel packing** | Either the packed `ORM` output _or_ separate roughness/metallic/AO.       |

That produces something like:

```
copper-plate/
  copper-plate_basecolor.png
  copper-plate_normal.png
  copper-plate_orm.png          # or _roughness/_metallic/_ambientOcclusion
  copper-plate_height.png       # optional
```

Rename the folder to the material id you want (`copper-plate`), drop it in
`public/assets/materials/`, and write a `material.json` beside the maps. The
filenames themselves do not matter — the manifest names them — so Sampler's
prefixed names can be left exactly as they are.

### The two things you cannot get wrong

**Colour space is not yours to declare.** The loader decides it per map, from
the channel, every time:

| Channel                                                   | Read as         |
| --------------------------------------------------------- | --------------- |
| `baseColor`, `emissive`                                   | **sRGB**        |
| `normal`, `orm`, `roughness`, `metalness`, `ao`, `height` | **linear data** |

There is no manifest key for it, and adding one would be rejected as an unknown
key. A double-gamma'd albedo or a gamma-decoded roughness map is the single most
common way a PBR pipeline ships subtly wrong, and it is not the sort of mistake
that shows up in a code review.

**Channel packing is fixed.** An `orm` map is occlusion in **R**, roughness in
**G**, metalness in **B** — the glTF layout. If you also export a separate
`roughness` map, it wins for that channel and the ORM map still supplies the
other two.

---

## 3. The `material.json` schema

Every key is optional. A folder containing nothing but `{}` is a valid, dull,
white material.

```json
{
  "name": "Hammered copper plate",
  "description": "Free-text; shown nowhere yet, useful in review.",

  "maps": {
    "baseColor": "basecolor.png",
    "normal": "normal.png",
    "orm": "orm.png",
    "roughness": "roughness.png",
    "metalness": "metallic.png",
    "ao": "ao.png",
    "height": "height.png",
    "emissive": "emissive.png"
  },

  "normal": {
    "convention": "opengl",
    "scale": 1
  },

  "tiling": [1, 1],
  "offset": [0, 0],
  "rotation": 0,

  "scalars": {
    "baseColor": "#b87333",
    "metalness": 1,
    "roughness": 0.38,
    "emissive": "#000000",
    "emissiveIntensity": 1,
    "aoIntensity": 1,
    "displacementScale": 0,
    "displacementBias": 0
  },

  "physical": {
    "clearcoat": 0.08,
    "clearcoatRoughness": 0.5,
    "anisotropy": 0.45,
    "anisotropyRotation": 1.5708,
    "sheen": 0,
    "sheenRoughness": 1,
    "sheenColor": "#ffffff",
    "ior": 1.5,
    "specularIntensity": 1,
    "iridescence": 0
  }
}
```

### `maps`

Channel -> filename, relative to the folder. To offer a compressed alternative,
give an object instead of a string:

```json
"baseColor": { "file": "basecolor.png", "ktx2": "basecolor.ktx2" }
```

Common alternative spellings are accepted, so Sampler's own naming works
unedited: `basecolor`, `base_color`, `albedo`, `diffuse`, `color`, `metallic`,
`ambientOcclusion`, `occlusion`, `displacement`, `emission`, `arm`. **Anything
else is reported as a typo** rather than silently ignored — `rougness` fails
loudly, which is the whole point.

A `height` map is not downloaded at all unless `scalars.displacementScale` is
non-zero. These are low-poly procedural meshes with nothing to displace.

### `normal`

`convention` is `"opengl"` (Y+, the default) or `"directx"`. A DirectX map is
corrected on load by inverting the green channel's contribution — no image is
rewritten and nothing has to be re-baked. `scale` multiplies the perturbation;
1 is the authored strength.

### `tiling`, `offset`, `rotation`

`tiling` is a `[u, v]` pair or a single number for both. It is expressed in the
surface units below, so it means the same thing on every part. `rotation` is in
radians.

### `scalars`

What is used wherever a map is absent. A material with no roughness map is not
an error — it is a uniformly rough material, and this is where it says how
rough. Colours accept `"#rrggbb"` or a number (`0xb87333`).

Where a map _is_ present, three.js multiplies it by the corresponding scalar, so
the loader sets the scalar to the neutral value (white / 1.0) rather than
leaving the authored one on top of it. That is why a base-colour map does not
come out double-tinted.

### `physical`

Optional `MeshPhysicalMaterial` extras, each mapping 1:1 onto the three.js
property of the same name. Anything omitted stays at the three.js default —
including across a look change, so a clearcoated material cannot leave clearcoat
behind on the one that follows it.

**They are not free.** Clearcoat, anisotropy, sheen, iridescence and
transmission each add a BRDF lobe evaluated per pixel. Measured on the reference
scene under software rendering, clearcoat plus anisotropy across the case and
the drums cost roughly an eighth of the frame budget — so declare them on
materials that cover a small part of the frame, or where the look genuinely
needs them, rather than by default. The shipped `dark-enamel` uses clearcoat on
the numerals for exactly that reason; the two metals declare none.

---

## 4. Registering a material and assigning it to a slot

There is no registration step. A folder is found by its name.

A scene binds its ten material slots in its own definition file
(`src/scene/scenes/*.ts`). To use a material folder, name it:

```ts
import { pbr } from '../../materials/looks.js';

materials: {
  housing: pbr('copper-plate', { roughness: 1.1 }),
  bezel:   pbr('copper-plate', { tiling: [1.2, 1.2] }),
  ring:    pbr('copper-plate'),
  numerals: pbr('dark-enamel'),
  // …
}
```

The optional second argument overrides the manifest per slot:

- `tiling` **replaces** the manifest's tiling.
- `roughness` / `metalness` are **multipliers** over the authored maps, and
  stand in for the manifest scalar where there is no map to multiply.

The slots are fixed in `MATERIAL_SLOTS` and each is consumed by real geometry;
`docs/assets.md` lists which parts take which slot. Placeholder bindings still
work and still make sense — `slate-orrery` is deliberately left untextured — so
the two kinds coexist within and across scenes.

### Looks

A **look** is a slot -> material-id mapping applied over whatever the scene
declares: `src/materials/looks.ts`. The settings panel exposes the shipped ones
in its **Material look** picker, and switching applies at runtime with no
reload, no scene rebuild and no untextured frame in between.

`uv-grid` is one of them, and it is a diagnostic rather than a style — see
below.

---

## 5. UVs and texel density

**One UV unit is one metre of real surface, on every part.** So `"tiling": [2, 2]`
repeats twice per metre on the drums, on the case, on a gear face and on the
engraved numerals alike, and an artist tuning one number is tuning it for the
whole clock.

Reaching that took work, because three.js parameterises each primitive to suit
itself. `src/render/geometry/uv.ts` holds the three ways a generator gets there:

| Helper             | Used by                                         | Notes                                                                                                                                                                                                               |
| ------------------ | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `latheUvToSurface` | drum body, bezel, case shell, lid               | Rescales the lathe's 0…1 span by the real circumference and profile length. A profile that is a _flat disc_ closing on the axis is planar-projected instead, or the texture collapses into a starburst at the pole. |
| `boxProjectUv`     | gears, studs, hinge, shackle, escapement, arbor | Projects from world position along each face's dominant axis. Uniform by construction; the cost is a seam where a surface curves past 45 degrees.                                                                   |
| `planarUv`         | flat discs (the lid)                            | One projection axis for the whole part, so a nearly-flat surface gets no seam at all.                                                                                                                               |

The numerals are the interesting case, and the reason this section exists.

### The numeral UVs

Digit glyphs are authored as 2D outlines, extruded flat, and then **bent** onto
the drum. The UVs `ExtrudeGeometry` writes describe the flat glyph — the shape
before it was curved — so any texture on the `numerals` slot was stretched
around the bend, differently for each of the ten digits, because each is bent
about a different part of the circle. Invisible while every material was an
untextured placeholder; glaring the moment one was not.

`createRingNumeralsGeometry` now restates the UVs in the same pass that bends
the geometry, into the cylindrical frame the drum itself lives in: `u` is arc
length around the drum, `v` is distance along the ring axis. Because the bend
angle is known analytically at that point, the mapping is exact rather than
fitted, and it is _continuous with the drum underneath_ — the numerals and the
drum share one unbroken parameterisation, so a material tiled across both lines
up instead of shearing at every glyph edge.

Verified two ways:

- **Measured.** `src/render/geometry/uv.test.ts` asserts uniform texel density
  across all ten glyphs (within 0.5%), equal scale along the axis and around the
  drum (square texels, not rectangles), and that `u` spans exactly one
  circumference.
- **Looked at.** Select **Material look -> UV grid (diagnostic)** in the
  settings panel and zoom in on the drums. The checker runs straight off the
  drum surface onto the raised digits without changing size or direction. The
  grid's red first row and green first column make a flip or a rotation
  obvious rather than something to be inferred.

Keep the `uv-grid` look in mind when adding a generator — it is the fastest way
to see what a new part's UVs actually are.

---

## 6. Sample materials shipped here

Four folders live in `public/assets/materials/`. They are **synthetic but
format-accurate**: generated by `scripts/generate-material-textures.mjs`, not
exported from Sampler (which cannot run in this environment), but written with
the same naming, the same ORM channel packing, the same colour spaces and the
same OpenGL normal convention that Sampler's glTF template produces. Swapping in
a real Sampler folder is a file copy.

| Folder         | Exercises                                                     |
| -------------- | ------------------------------------------------------------- |
| `copper-plate` | ORM-packed export                                             |
| `blued-steel`  | Separate roughness/metallic/AO maps                           |
| `dark-enamel`  | **No maps at all** — scalars only, zero requests; `clearcoat` |
| `uv-grid`      | The UV diagnostic checker                                     |

Regenerate with `npm run materials:generate`.

---

## 7. Texture size and delivery

**Cap textures at 2048 px.** Everything is mipmapped, repeat-wrapped, and
filtered anisotropically at up to 4x.

4x rather than the 16x the hardware reports: anisotropic filtering is
per-sample work, and on the drums — where it matters, since they are read at a
grazing angle — the step from 4x to 16x is not visible at this framing.
Measured under software rendering, 8x to 4x returned about a quarter of the
frame budget.

### KTX2 / BasisU

A manifest may list a `.ktx2` beside each PNG. The compressed file is used only
where a transcoder can actually run; otherwise the uncompressed file — which
every manifest must still list — is used silently.

```
npm run materials:compress -- copper-plate
npm run materials:compress -- --all
```

Requires `toktx` from the KTX-Software toolkit (`brew install ktx`). The script
writes each `.ktx2`, adds it to the manifest, and gets two things right that a
hand-rolled invocation usually does not: per-map colour space (`--assign_oetf`
matched to the channel) and orientation (`--lower_left_maps_to_s0t0`, because a
KTX2 payload cannot be flipped at load time the way a PNG can, and a material
that flips when you compress it is a maddening bug).

The transcoder itself is copied out of `three` into `public/basis/` by
`scripts/sync-basis-transcoder.mjs`, which `predev` and `prebuild` run. It is
never committed: it is an exact function of the installed `three` version, so a
committed copy could only go stale. `KTX2Loader` is dynamically imported, so a
project shipping only PNGs never downloads it.

**Status: implemented and unit-tested, not exercised with real `.ktx2` assets** —
no compressed textures are committed here, because `toktx` is not available in
this environment.

---

## 8. Runtime behaviour

- **Lazy.** A folder is fetched when a slot first names it, and cached in the
  `MaterialRegistry` for the life of the page.
- **Shared.** One decode per file however many slots use it. Per-slot `tiling`
  gets its own lightweight `Texture` sharing the same image, so the download is
  not repeated.
- **Reference counted.** When the last slot lets go, the texture is disposed.
  `e2e/materials.spec.ts` swaps looks three full round trips and asserts
  `renderer.info.memory.textures` lands exactly where it started.
- **Never blank.** A slot shows a neutral surface until its manifest arrives,
  and on a swap keeps the material it already has until the replacements have
  decoded — so there is no untextured frame to catch.
- **Never wrong-order.** Each load is stamped with a generation; one that
  finishes after a newer binding was requested releases what it acquired and
  returns without touching the material.
- **Never fatal.** A missing or malformed folder warns once and leaves a
  neutral surface. `MaterialManifestError` lists every problem in the file at
  once rather than failing on the first.
- **Base-path safe.** Texture and transcoder URLs are joined onto
  `import.meta.env.BASE_URL`, because they are fetched at runtime and Vite
  therefore never rewrites them. A deployment under `/babbage-clock/` would
  otherwise 404 on every map — silently, since the fallback is a neutral
  surface.

Boot waits for the first scene's materials: `main.ts` registers a `materials`
task with the `LoadingTracker`, so the loading screen stays up until the clock
is fully skinned and a screenshot can never catch it half-loaded.

---

## Follow-ups

- **glTF material import** — lift the first material out of a `.gltf`/`.glb`
  and register it as a folder-equivalent. Not implemented.
- **MaterialX** via three's `MaterialXLoader` — experimental upstream. Not
  implemented.
- **Ship a real Sampler export** to replace the synthetic set.
- **Commit a `.ktx2` fixture** so the compressed path is covered end to end
  rather than only in unit tests.
