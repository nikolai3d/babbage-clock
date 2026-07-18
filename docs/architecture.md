# Architecture

Babbage Clock is a vanilla TypeScript + three.js single-page app. There is no UI
framework and no build magic beyond Vite.

The central idea is the **scene registry**: everything about how a clock looks —
how many digit rings it has, how they are laid out, which materials they use,
how they are lit, how the camera frames them — is _data_, held in a
`SceneDefinition`. The render code reads that data and never hardcodes it. Adding
a new look means adding a data file, not editing the renderer.

## Layout

```
src/
  main.ts                bootstrap: read URL -> build store -> wire renderer + UI
  app/
    store.ts             the observable app-state store (framework-free)
    urlParams.ts         ?scene= / ?target= reading and writing
  geometry/              ── pure geometry maths, no three.js ──
    types.ts             Point2/Contour/Outline plus small 2D helpers
    strokes.ts           centre-line stroke -> filled outline
    digitGlyphs.ts       the procedural stroke font for 0-9
    gearProfile.ts       involute tooth profiles, spoke and crescent cutouts
    ringLayout.ts        digit angles, ring offsets, numeral sizing
  scene/                 ── no three.js imports anywhere below this line ──
    types.ts             SceneDefinition and everything it contains
    validate.ts          structural checks for scene definitions
    registry.ts          SceneRegistry: lookup, listing, ?scene= resolution
    materialHelpers.ts   terse constructors for material bindings
    scenes/
      index.ts           the list of scenes + the app-wide registry instance
      copperPadlock.ts   preset 1: 7-ring copper cryptex
      slateOrrery.ts     preset 2: 5-ring slate variant
  render/                ── the only place three.js is used ──
    renderer.ts          WebGL context, camera, OrbitControls, frame loop
    clockScene.ts        SceneDefinition -> three.js objects
    geometry/            outlines and configs -> BufferGeometry
      extrude.ts         Outline -> Shape -> ExtrudeGeometry, merging, bending
      gear.ts            createGearGeometry
      ring.ts            createRingBodyGeometry / createRingNumeralsGeometry
      housing.ts         createHousingParts (case, bezel, studs, lid, shackle)
    materials.ts         material slot map -> three.js materials
    lighting.ts          lighting config -> three.js lights
  time/                  ── pure, no DOM, no three.js ──
    index.ts             the module's public surface (see docs/timing.md)
    countdown.ts         countdown maths, digit packing, HHH:MM:SS clamp
    target.ts            TimeSource + timezone-aware target resolution
    trueTime.ts          network-corrected, monotonic in-session clock
    providers.ts         the time-source fallback chain
  ui/
    hud.ts               countdown readout + scene picker
```

Three boundaries matter and should be preserved:

1. **`geometry/` never imports three.js.** Tooth profiles, glyph outlines and
   digit angles are plain maths over `{x, y}` points. `render/geometry/` is the
   only place those become GPU buffers. This is the same rule as below, applied
   to the generators: it is why the tooth profile, the digit angle mapping and
   the numeral sizing rules are unit-tested without a WebGL context.
2. **`scene/` and `time/` never import three.js.** That is what makes them
   unit-testable without a WebGL context, and it is why the test suite runs in a
   plain Node environment.
3. **`ui/` never imports three.js either.** The UI reads the app store and emits
   intents (`onSelectScene`); `main.ts` decides what those mean. The renderer
   subscribes to the same store. If a UI bead finds itself importing `three`,
   the state it needs belongs in the store instead.

## Data flow

```
URL params ──▶ main.ts ──▶ Store<AppState> ──▶ Hud (DOM)
                  │              ▲
                  │              │ countdown, fps, hidden
                  └──▶ ClockRenderer ──▶ ClockSceneView ──▶ three.js scene graph
                              ▲
                        SceneRegistry.resolve()
```

The frame loop lives in `ClockRenderer`. Each frame it asks the `TimeSource` for
the current time, computes the countdown, packs it into digits sized to the
active scene's ring count, and hands those to `ClockSceneView`. It pushes to the
store only every 250 ms, because the store drives DOM updates.

The loop pauses when `document.hidden` and resumes on `visibilitychange`.
Device pixel ratio is capped at 2. Frame deltas are clamped so a long-hidden tab
does not resume with a huge time step.

## SceneDefinition

See `src/scene/types.ts` for the authoritative definitions.

```ts
interface SceneDefinition {
  id: string; // used by ?scene=
  name: string; // shown in the picker
  description: string;
  mode: 'countdown' | 'clock';
  rings: RingConfig; // count / radius / thickness / spacing / axis / slots
  gears: readonly GearSpec[]; // decorative rotating discs
  materials: MaterialSlotMap; // every named slot -> a MaterialBinding
  lighting: LightingConfig; // background, ambient, directionals, environment
  camera: CameraConfig; // placement + OrbitControls framing limits
}
```

Rings are coaxial, cryptex style: `rings.count` rings laid out along
`rings.axis`, each rotating about that same axis. `mode` selects what they read
out — `countdown` packs the remaining time least-significant-first, `clock` shows
wall-clock `HHMMSS`.

## Geometry generation

Nothing in the scene graph is a fixed mesh. `ClockSceneView` assembles geometry
that the generators compute from the same `SceneDefinition` the rest of the app
reads:

- **Gears** — `createGearGeometry` extrudes an involute profile with a solid,
  5-spoke, 6-spoke or crescent-cutout web. Teeth are part of the profile, not
  instanced boxes.
- **Rings** — `createRingBodyGeometry` and `createRingNumeralsGeometry` are
  functions of `RingConfig`. Change `rings.count` or `rings.radius` in a scene
  file and the drums, the numerals and the case that encloses them all follow.
  Both buffers are built once and shared by every ring in the stack.
- **Numerals** — a procedural stroke font, extruded and bent onto the drum.
  Digit `d` is engraved at `digitAngle(d)`, which is exactly the angle
  `setDigits` rotates to. See `docs/assets.md` for why this rather than a
  texture atlas.
- **Housing** — `createHousingParts` returns the case, bezel, screw studs, open
  lid, hinge and shackle, each tagged with the material slot it belongs to. It
  is sized to enclose whatever the scene contains.

Conventions (units, origin, axes, polygon budgets, the material-slot contract
for authored glTF) live in **[assets.md](assets.md)**.

## How to add a new scene

1. Copy `src/scene/scenes/slateOrrery.ts` to a new file and change the numbers.
2. Add it to the `allScenes` array in `src/scene/scenes/index.ts`.

That is the whole procedure. It is now listed in the picker and reachable at
`?scene=<id>`. The registry validates every scene at construction, so a
mistake — rings that would intersect, an unbound material slot, inverted camera
limits — fails loudly and immediately rather than rendering something wrong.

**Planned 6-ring clock variant:** copy a preset, set `rings.count: 6` and
`mode: 'clock'`. No render-code changes are required; `clockDigits` already
produces exactly six digits for that case, and the ring, numeral and housing
generators are all functions of `RingConfig`.

## Extension points

These are typed and wired but intentionally not implemented yet. Each is a real
interface rather than a TODO, so the bead that fills it in should not need to
change anything outside its own module.

### Materials (Substance PBR bead)

`MaterialBinding` is a discriminated union. `{ kind: 'placeholder' }` is the
untextured material the scaffold ships. `{ kind: 'pbr' }` already carries a
`textureSet`, per-channel `maps`, `tiling` and roughness/metalness overrides.

`MaterialLibrary` in `src/render/materials.ts` currently warns and substitutes a
neutral material for `pbr` bindings. The materials bead implements loading
there. Scene files then change from `placeholder(...)` to `{ kind: 'pbr', ... }`
per slot, and nothing else moves.

Slot names are fixed in `MATERIAL_SLOTS`: `housing`, `bezel`, `ring`,
`numerals`, `gearA`–`gearD`, `arbor`, `frame`. Authored texture sets should be
keyed by these names. Every slot is now consumed by geometry: the case takes
`housing`, the bezel and its studs take `bezel`, the lid, hinge and shackle take
`frame`.

### Lighting / IBL (environment bead)

`LightingConfig.environment` carries an `EnvironmentSpec` with a `preset` id
(`day`, `sunny-day`, `night`, `steampunk-workshop`, `busy-street`, or `none`),
an `intensity` and a `showAsBackground` flag. `SceneLighting` in
`src/render/lighting.ts` currently warns for any non-`none` preset. The IBL bead
loads the environment map there and sets `scene.environment` (plus
`scene.background` when requested). Analytic lights stay as the fallback.

### Time (implemented)

`TimeSource` in `src/time/target.ts` is still the one-method seam
(`now(): number`), and `main.ts` now injects `trueTimeSource` — a clock that is
monotonic within the session and corrected against the network. Nothing else
reads `Date.now()`.

Targets resolve through the real IANA tz database (Temporal), accept
`?target=…&tz=…`, and report DST gap/overlap adjustments instead of hiding
them. With no `?target=` the countdown is the next 1 January 00:00 in the
viewer's timezone, so the landing page always shows a live countdown.

See **[docs/timing.md](timing.md)** for the API reference, the time-source
fallback chain and the accuracy tiers. `AppState.timeStatus` carries the tier
and the clock-skew warning for the UI to surface.

### E2E / screenshots

Not present. A later bead adds Playwright, screenshots, video and CI artifacts.
The current test suite deliberately runs in a Node environment with no DOM, and
covers time maths, the registry, the store, and scene-graph construction —
`ClockSceneView` is testable headlessly because building a three.js scene graph
does not require a GL context.

## Resource ownership

`ClockSceneView` owns every geometry, material and light it creates and releases
all of them in `dispose()`. `ClockRenderer.setScene()` disposes the outgoing view
before building the new one.

This matters: scenes are switchable at runtime and later beads will swap them
repeatedly. Any new geometry added to `ClockSceneView` must be registered with
`this.track(...)`, and any new material must come from the `MaterialLibrary`,
otherwise it will leak on every switch. There is a test that asserts every
geometry and material created is disposed.

Generators return geometry the caller owns; they never hold a reference of their
own. Anything that owns a GPU resource beyond its geometry and material — an
`InstancedMesh` and its instance-matrix buffer, which the bezel studs use — goes
into `disposables` as well, and there is a regression test for that too.

## Renderer decisions

- **WebGL2 via the classic `WebGLRenderer`.** WebGPU is explicitly deferred; do
  not introduce `WebGPURenderer`.
- **Vanilla TypeScript.** No React/Svelte/Vue.
- Tone mapping is ACES Filmic; per-scene exposure comes from
  `lighting.exposure`.
