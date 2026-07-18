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
    materials.ts         material slot map -> three.js materials
    lighting.ts          lighting config -> three.js lights
  time/                  ── pure, no DOM, no three.js ──
    countdown.ts         countdown maths and digit packing
    target.ts            TimeSource + countdown target resolution
  ui/
    hud.ts               countdown readout + scene picker
```

Two boundaries matter and should be preserved:

1. **`scene/` and `time/` never import three.js.** That is what makes them
   unit-testable without a WebGL context, and it is why the test suite runs in a
   plain Node environment.
2. **`ui/` never imports three.js either.** The UI reads the app store and emits
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

## How to add a new scene

1. Copy `src/scene/scenes/slateOrrery.ts` to a new file and change the numbers.
2. Add it to the `allScenes` array in `src/scene/scenes/index.ts`.

That is the whole procedure. It is now listed in the picker and reachable at
`?scene=<id>`. The registry validates every scene at construction, so a
mistake — rings that would intersect, an unbound material slot, inverted camera
limits — fails loudly and immediately rather than rendering something wrong.

**Planned 6-ring clock variant:** copy a preset, set `rings.count: 6` and
`mode: 'clock'`. No render-code changes are required; `clockDigits` already
produces exactly six digits for that case.

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
keyed by these names. Not every slot is used by the placeholder geometry yet —
they are bound in every scene so later geometry can use them without touching
scene files again.

### Lighting / IBL (environment bead)

`LightingConfig.environment` carries an `EnvironmentSpec` with a `preset` id
(`day`, `sunny-day`, `night`, `steampunk-workshop`, `busy-street`, or `none`),
an `intensity` and a `showAsBackground` flag. `SceneLighting` in
`src/render/lighting.ts` currently warns for any non-`none` preset. The IBL bead
loads the environment map there and sets `scene.environment` (plus
`scene.background` when requested). Analytic lights stay as the fallback.

### Time (timezone / NTP bead)

`TimeSource` in `src/time/target.ts` is a one-method interface (`now(): number`).
The scaffold uses the system clock; the NTP bead supplies a skew-corrected
implementation and `main.ts` passes it instead. Nothing else reads `Date.now()`.

Target resolution is `resolveCountdownTarget(param, nowMs)`. With no `?target=`
it returns the next 1 January 00:00 in the viewer's local timezone, so the
landing page always shows a live countdown.

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

## Renderer decisions

- **WebGL2 via the classic `WebGLRenderer`.** WebGPU is explicitly deferred; do
  not introduce `WebGPURenderer`.
- **Vanilla TypeScript.** No React/Svelte/Vue.
- Tone mapping is ACES Filmic; per-scene exposure comes from
  `lighting.exposure`.
