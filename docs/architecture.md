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
    urlParams.ts         ?scene= / ?target= / ?tz= / ?mood= reading, writing, sharing
    loading.ts           weighted boot-progress aggregation for the loading screen
    motion.ts            the one motion switch: reduced-motion + ?nomotion
    quality.ts           device profile -> render tier; ?quality= and the override
    countdownTicker.ts   advances the countdown when there is no render loop
  geometry/              ── pure geometry maths, no three.js ──
    types.ts             Point2/Contour/Outline plus small 2D helpers
    strokes.ts           centre-line stroke -> filled outline
    digitGlyphs.ts       the procedural stroke font for 0-9
    gearProfile.ts       involute tooth profiles, spoke and crescent cutouts
    ringLayout.ts        digit angles, ring offsets, numeral sizing
  mechanism/             ── the moving parts, no three.js (see docs/mechanism.md) ──
    easing.ts            the escapement curve and friends
    mechanism.ts         tick / carry / seek / expire state machine
    frames.ts            RemainingTime or wall clock -> a mechanism frame
  materials/             ── the Substance material contract, no three.js ──
    manifest.ts          material.json parsing, validation, colour-space rules
    looks.ts             slot -> material-id mappings; the `pbr()` binding helper
    paths.ts             runtime asset URLs, resolved against BASE_URL
  scene/                 ── no three.js imports anywhere below this line ──
    types.ts             SceneDefinition and everything it contains
    validate.ts          structural checks for scene definitions
    framing.ts           CameraConfig + viewport aspect -> the pose to use
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
      extrude.ts         Outline -> Shape -> ExtrudeGeometry, merging, bending,
                         and the attribute passes that follow (subdivision, normals)
      gear.ts            createGearGeometry
      ring.ts            createRingBodyGeometry / createRingNumeralsGeometry
      housing.ts         createHousingParts (case, bezel, studs, lid, shackle)
      escapement.ts      balance, escape wheel, cock, detent lever
    materials.ts         material slot map -> three.js materials, hot-swappable
    materialRegistry.ts  material folders -> cached, refcounted textures
    lighting.ts          scene lights + EnvironmentController (applies a mood)
    ibl/                 lighting moods: HDR panorama + rig + grade
      manifest.ts        preset.json schema and parser (no three.js)
      presets.ts         discovers assets/ibl/*/ at build time, lazily
      library.ts         panorama -> PMREM, cached and disposed
      rig.ts             manifest -> analytic lights and gradient backdrop
  time/                  ── pure, no DOM, no three.js ──
    index.ts             the module's public surface (see docs/timing.md)
    countdown.ts         countdown maths, digit packing, HHH:MM:SS clamp
    target.ts            TimeSource + timezone-aware target resolution
    trueTime.ts          network-corrected, monotonic in-session clock
    providers.ts         the time-source fallback chain
  ui/                    ── no three.js imports here either ──
    hud.ts               the shell: readout, status strip, drawer toggle, toasts
    countdownAnnouncer.ts the throttled aria-live mirror of the countdown
    countdownSpeech.ts   phrasing and announcement cadence (pure)
    fallbackClock.ts     the text countdown for no-WebGL / lost context
    settingsPanel.ts     the settings drawer (target, zone, controls, share)
    settings.ts          SettingControl descriptors — how a setting is added
    timeZonePicker.ts    searchable combobox over the platform tz database
    timeZones.ts         zone list, search ranking, offset labels (pure)
    targetSummary.ts     both-zone echo and DST notes for display (pure)
    statusText.ts        TrueTimeStatus -> the sentence to show (pure)
    loadingScreen.ts     drives the themed loader in index.html
    toast.ts             transient confirmations
    debugPanel.ts        dev-only diagnostics; never imported statically
```

Four boundaries matter and should be preserved:

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
4. **`mechanism/` never imports three.js.** Ticks, carry cascades, easing and
   the wind-down are decided over plain digit arrays and angles, so the
   boundary cases are unit tests rather than screenshots. `ClockSceneView`
   samples it and writes transforms; it never re-decides any of it. See
   **[mechanism.md](mechanism.md)**.

## Data flow

```
URL params ──▶ main.ts ──▶ Store<AppState> ──▶ Hud ──▶ SettingsPanel (DOM)
                  ▲ │           ▲    │                       │
          intents │ │           │    └───────────────────────┘
                  │ │           │ countdown, fps, hidden
                  └─┼───────────┴──── UI intents (target, scene, mood, share)
                    └──▶ ClockRenderer ──▶ ClockSceneView ──▶ three.js scene graph
                                ▲
                          SceneRegistry.resolve()
```

The UI never writes to the store and never resolves a target itself: it emits an
intent, `main.ts` decides what that means, and the result arrives back through
the store. That is why the panel can be rebuilt or replaced without touching
anything else, and why the same state that draws the DOM also draws the rings.

The frame loop lives in `ClockRenderer`. Each frame it asks the `TimeSource` for
the current instant, turns it into a `RemainingTime` with `computeRemaining` —
so the `HHH:MM:SS` cap reaches the rings — packs that into digits sized to the
active scene's ring count, and hands the frame to `ClockSceneView`, which feeds
the mechanism and samples it. It pushes to the store only every 250 ms, because
the store drives DOM updates.

Nothing in that path integrates a frame delta: every transform is a function of
the instant, which is what keeps the display correct across tab sleeps and clock
re-syncs. The delta is used for the fps readout and nothing else.

The loop pauses when `document.hidden` and resumes on `visibilitychange`. That
is the battery behaviour a backgrounded tab depends on, and `e2e/boot.spec.ts`
asserts it rather than trusting it.

## Framing and quality

Two decisions the renderer makes for itself, both from data, both pure enough to
unit-test without a GPU.

### Aspect-aware framing (`scene/framing.ts`)

A `CameraConfig` is authored while looking at a 16:9 frame. A portrait phone
keeps the same _vertical_ field of view and collapses the horizontal one, so a
pose that comfortably contains the mechanism on a desktop cuts the ends off the
ring stack on a phone — and the ring stack is the readout.

`frameForAspect` re-derives the distance:

1. It reads the author's intended tightness off the authored pose, as a multiple
   of the exact fit at the reference aspect. At 16:9 it therefore reproduces the
   authored numbers exactly, and a scene deliberately framed loose stays loose.
2. At any aspect wide enough to hold the whole mechanism, nothing moves.
3. At a narrower one it pulls back only as far as keeping the **rings** in frame
   requires, and lets the case run off the edges. Fitting the whole case into a
   portrait frame would shrink the numerals to nothing, which is the opposite of
   the point.

Only the distance changes; the authored view direction is the composition and is
left alone. The content radius is measured off the built scene graph, so a scene
that grows a part reframes itself, and a new scene inherits all of this without
knowing the module exists.

The renderer re-frames on resize, but **only until the viewer moves the camera
themselves** — after a drag, a pinch or an arrow key, the aspect ratio tracks the
orbit _limits_ and never the pose. `Home` puts it back and re-arms the automatic
framing.

### Quality tiers (`app/quality.ts`)

`detectQualityTier` maps a `DeviceProfile` — pointer type, viewport, cores,
memory — onto `high` or `low`. Every phone lands on `low`; so does a machine with
four cores or less, one that reports 4 GB or less, and a large scaled display
without the cores to feed it. The tier sets the pixel-ratio cap (2 or 1.5), a
frame ceiling (none or 30 fps), whether a lighting mood may draw its HDR panorama
as the background, the texture size the material pipeline should prefer, and the
resolution of the shadow map a mood's casting key light renders into (2048 or
1024 — see [lighting.md](lighting.md)).

The viewer always wins: `?quality=` pins it and the drawer's Render quality
control changes it live, because everything a tier controls is re-derivable.
`ClockRenderer.refresh()` re-asserts all of it after a lost context comes back,
which a restored context needs because it returns at the browser's defaults.

The tier is **not** part of a shared link. It describes the device it was chosen
on, and sending "low quality" to whoever opens the link would be nonsense.

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
  escapement?: EscapementPlacement; // balance centre + escape-wheel offset override
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
  Digit `d` is engraved at `digitAngle(d)`, which is exactly the angle the
  mechanism rotates to. See `docs/assets.md` for why this rather than a texture
  atlas.
- **Housing** — `createHousingParts` returns the case, bezel, screw studs, open
  lid, hinge and shackle, each tagged with the material slot it belongs to. It
  is sized to enclose whatever the scene contains.
- **Escapement** — `createEscapementParts` returns the balance wheel, its escape
  wheel and the cock that holds them; `createDetentLeverGeometry` returns the
  pawl that rides on each ring. These are sized from the case and, by default,
  placed from it too, so every scene gets a movement without editing a scene
  file; a scene whose layout wants them elsewhere declares the optional
  `escapement` placement in its definition.

Conventions (units, origin, axes, polygon budgets, the material-slot contract
for authored glTF) live in **[assets.md](assets.md)**.

## How to add a new scene

1. Copy `src/scene/scenes/slateOrrery.ts` to a new file and change the numbers.
2. Add it to the `allScenes` array in `src/scene/scenes/index.ts`.

That is the whole procedure. It is now listed in the picker and reachable at
`?scene=<id>`. The registry validates every scene at construction, so a
mistake — rings that would intersect, an unbound material slot, inverted camera
limits — fails loudly and immediately rather than rendering something wrong.

A scene's gear train is data too, and two properties of it are asserted in
`registry.test.ts` rather than left to the eye: meshed neighbours counter-rotate,
and smaller wheels turn faster. Author a chain by keeping one module
(`m = 2r/teeth`) across the wheels, placing each centre `r + r'` from the last,
and taking each speed as `-w * teeth / teeth'`. Wheels must also sit clear of
the ring stack — the test checks that too.

**Planned 6-ring clock variant:** copy a preset, set `rings.count: 6` and
`mode: 'clock'`. No render-code changes are required; `clockDigits` already
produces exactly six digits for that case, the mechanism already turns the drums
the other way for a readout that counts up (`clockFrame`), and the ring, numeral
and housing generators are all functions of `RingConfig`.

## The UI shell

Vanilla TypeScript and hand-written DOM — no framework, no component library
(owner decision). Real elements throughout: `<button>`, `<label>`, `<input>`,
`<form>`, so the accessibility bead has something to work with rather than div
soup.

The structure later beads extend:

```
#scene-canvas               [role=img][aria-label][tabindex=0]; arrow keys orbit
p#canvas-help.sr-only
#ui-root
  .hud
    .readout#readout          p#countdown[role=timer][aria-live=off], p#target-label, p.readout__state
    .status#time-status       span.status__dot, span.status__text, [data-level=ok|info|warn]
    button#settings-toggle    [aria-expanded][aria-controls=settings-panel]
    section#settings-panel.panel[hidden]
      .panel__head            h2#settings-title, button#settings-close
      form#target-form        input#target-input[type=datetime-local][step=1]
                              .tzpicker > input#tz-input[role=combobox] + ul#tz-input-listbox[role=listbox]
                              p#target-error[role=alert]
                              button#target-apply, button#target-reset
      .field#clock-zone-field .tzpicker > input#clock-zone-input[role=combobox] + ul[role=listbox]
                              p#clock-zone-error[role=alert]
                              (clock mode only — swaps in for the target form)
      .echo#target-echo       dl.echo__rows, p.echo__adjustment, ul.echo__notes, p.echo__origin
      .panel__group           one .field per SettingControl descriptor
      .field--share           input#share-url[readonly], button#share-button
    .toast-region[role=status]
  p#countdown-announcement.sr-only[aria-live=polite][aria-atomic=true]
  section#fallback-view.fallback[hidden]   the text countdown, when there is no GPU
#loading-screen.loader        authored in index.html, removed once boot completes
```

`#countdown` and `#countdown-announcement` are a pair, and the split is
deliberate: `role="timer"` is an implicit live region and the readout changes
four times a second, so it is pinned to `aria-live="off"` and the throttled
announcements happen in the hidden element instead. Exactly one is ever live.
See **[accessibility.md](accessibility.md)**.

Hiding is done with the `hidden` attribute so hidden content leaves the
accessibility tree and the tab order together; `[hidden] { display: none
!important }` in `styles.css` keeps a `display` rule from quietly overriding it.

**Small viewports** (`width <= 40rem`) turn the drawer into a bottom sheet, and
move the readout from the bottom-left corner to the top of the shell _while the
sheet is open_ — the sheet used to cover it, which meant opening the settings
hid the countdown. It is a grid change on `.hud--settings-open`, not a scroll, so
the readout is never partly obscured. The shell's padding is `max(design
padding, env(safe-area-inset-*))`, which is the design's own spacing everywhere
that has no notch. `(pointer: coarse)` gives every control a 44px target and
inputs a 16px font — below that, iOS Safari zooms the page on focus.

Adding a setting means appending a descriptor in `main.ts` — see
`ui/settings.ts`. Nothing in the panel changes.

Boot progress is real, not simulated: work registers a task with
`LoadingTracker` and reports against it (`app/loading.ts`). The texture and HDRI
beads plug a three.js `LoadingManager` straight into it.

**Share links** carry `?target=&tz=&scene=` plus `&mood=` when the viewer has
overridden the scene's lighting preset. The target is written as the wall clock
in the zone it was entered in, which round-trips exactly — including across DST
gaps and overlaps, which `app/urlParams.test.ts` asserts case by case.

## Extension points

These are typed and wired but intentionally not implemented yet. Each is a real
interface rather than a TODO, so the bead that fills it in should not need to
change anything outside its own module.

### Materials (implemented)

`MaterialBinding` is a discriminated union. `{ kind: 'placeholder' }` is an
untextured material, still a valid long-term binding — `slate-orrery` uses them
throughout. `{ kind: 'pbr', textureSet }` names a material folder under
`public/assets/materials/`, which the `MaterialRegistry` loads, parses and
caches. `copper-padlock` binds all ten of its slots that way, which is the
validation that the abstraction holds: re-skinning the whole clock changed ten
lines of scene data and no render code.

`MaterialLibrary.textureSize` carries the active quality tier's resolution
preference (`half` on the low tier), threaded from `app/quality.ts` through
`ClockSceneView`. It is recorded but not yet acted on: `material.json` has no
size variants to choose between. When variants are authored, resolve them there
rather than introducing a second notion of texture quality — texture memory is
the first thing a mobile browser kills a WebGL tab for.

Slot names are fixed in `MATERIAL_SLOTS`: `housing`, `bezel`, `ring`,
`numerals`, `gearA`–`gearD`, `arbor`, `frame`. Every slot is consumed by
geometry — the case and the bearing bosses take `housing`, the bezel, its studs
and the balance rim take `bezel`, the lid, hinge, shackle and balance cock take
`frame`, the arbor, gear pins and detent levers take `arbor`, and the escape
wheel takes `gearD`.

**The material instance for a slot never changes.** Meshes are handed it once
and keep the reference; rebinding a slot rewrites that instance in place, which
is what makes the settings panel's _Material look_ picker a runtime rebind
rather than a scene rebuild. Textures are reference counted in the registry,
which outlives any one scene, so switching scenes or looks re-downloads nothing
and releases everything.

See **[materials.md](materials.md)** for the `material.json` schema, the
Substance 3D Sampler export settings that produce a compatible folder, the
texel-density convention, and the KTX2 delivery path.

### Audio (sound bead)

`Mechanism.subscribe` already emits the events the animation runs on — `tick`,
`seek`, `expire`, each with the rings that move, the carry depth and the exact
start and duration. Play sound from those rather than from a timer of your own,
and it is in sync by construction. See **[mechanism.md](mechanism.md)**.

### Lighting / IBL (implemented)

`LightingConfig.environment` carries an `EnvironmentSpec` with a `preset` id
(`day`, `sunny-day`, `night`, `steampunk-workshop`, `busy-street`, or `none`),
an `intensity` and a `showAsBackground` flag. Each non-`none` id is a folder
under `assets/ibl/` holding a `preset.json` and an HDR panorama — content, not
code, the same as the scene registry. Dropping a folder in adds a mood.

`render/ibl/` implements it: `manifest.ts` is the schema and its parser (pure,
three.js-free), `presets.ts` discovers the folders with `import.meta.glob`,
`library.ts` decodes and PMREM-prefilters a panorama once per session and caches
it, and `rig.ts` builds the mood's analytic lights and its gradient backdrop.
`EnvironmentController` in `render/lighting.ts` applies a mood — environment,
background, rig, fog and grade — in one synchronous `commit`, so no frame is
drawn with one mood's map and another's lights. Loading never blocks first
paint; the previous mood stays whole until the next one is ready.

`SceneLighting` still owns the lights a scene declares for itself. A mood scales
them by its `sceneLightScale` (0 in every shipped mood) rather than removing
them, which is what makes reverting to `none` a single-frame operation.

The viewer-facing half was wired earlier: the settings panel's mood picker and
`?mood=` set `AppState.mood`, and `scene/environment.ts` overrides the active
scene's preset with it before `setScene`.

See **[docs/lighting.md](lighting.md)** for the manifest schema, how switching
stays atomic and leak-free, and how to add a mood.

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

Present. Playwright drives the built app in headless Chromium over ANGLE's
SwiftShader backend, covering boot, WebGL2 acquisition, the advancing readout,
`?scene=` switching and fallback, plus committed screenshot baselines. See
**[docs/testing.md](testing.md)** for how to run, debug and regenerate each
layer — in particular the Docker recipe for regenerating baselines, which you
will need after any deliberate visual change.

A second project, `mobile-portrait`, runs one spec at a 412x915 touch viewport
for the things a phone changes: the framing, the bottom sheet, touch orbit and
pinch, and the tier heuristic. It is deliberately not a second pass of the whole
suite — see [testing.md](testing.md) for why, and for the real-device checklist
that CI structurally cannot cover.

The unit suite still runs in a Node environment with no DOM, covering time
maths, the registry, the store, and scene-graph construction; `ClockSceneView`
is testable headlessly because building a three.js scene graph does not require
a GL context.

**Test hooks.** `src/app/testHooks.ts` adds a small, query-parameter-gated
surface used only by the e2e and capture layers: `?mockNow=` pins the clock
(through an adapter satisfying `TimeSource`, so `src/time/` is untouched),
`?nomotion=1` disables drift, gear rotation and easing, and `?testApi=1`
installs `window.__clock` for state assertions. **Every hook is inert without
its parameter** — production behaviour is unchanged, and unit tests assert it.
The renderer is consumed through a structural `RendererProbe` interface, so
nothing in `src/render/` imports test-only code.

`?nomotion=1` is a _hook_; the effective motion setting is
`?nomotion` combined with `prefers-reduced-motion` in `app/motion.ts`, and that
combined value is the only one the renderer sees. `window.__clock.hooks().motion`
reports the parameter, `renderer().motion` reports the effective value —
comparing them is how a spec tells the media query apart from the URL.

## Accessibility and fallbacks

Read **[accessibility.md](accessibility.md)** before touching the HUD, the
motion switch or the renderer's context handling. In short:

- The countdown reaches assistive technology as words through one throttled
  live region, not through the `role="timer"` readout.
- There is one motion switch (`app/motion.ts`). Do not add a second
  `prefers-reduced-motion` check anywhere.
- When there is no WebGL context — creation failed, or the one we had was lost —
  `ui/fallbackClock.ts` shows a text countdown that `app/countdownTicker.ts`
  keeps advancing off the same `TimeSource`. Neither imports three.js, and that
  is load-bearing: it is what makes the countdown survive the GPU.
- Chrome backgrounds are opaque enough to clear AA against _any_ backdrop,
  because IBL presets change what is behind them.

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

Lighting moods are the other repeatedly-swapped resource. `EnvironmentLibrary`
prefilters each panorama once and disposes every render target it holds;
`EnvironmentController` disposes the mood's light rig and its generated backdrop
on every change. Both have their own conservation tests, and the live GPU object
count was confirmed flat across 80+ mood switches in a real browser. See
[lighting.md](lighting.md).

## Renderer decisions

- **WebGL2 via the classic `WebGLRenderer`.** WebGPU is explicitly deferred; do
  not introduce `WebGPURenderer`.
- **A frame is drawn only when something changed.** The rAF loop always runs —
  it keeps the mechanism and the store current — but the GL work is skipped
  when the mechanism reports no motion (`ClockSceneView.update` returns
  false), the camera did not move, and no async mood or material commit is in
  flight. A live clock moves the drive phase continuously, so production draws
  every frame; a frozen `?mockNow` clock reaches a fixed point and holds the
  last frame, which is what makes screenshot captures bit-stable on a starved
  CI runner. Anything new that changes the picture without moving the
  mechanism must set `renderRequested` (see `ClockRenderer`).
- **Vanilla TypeScript.** No React/Svelte/Vue.
- Tone mapping and exposure are set by the active lighting mood's `grade`
  (ACES Filmic by default), multiplied by the scene's own `lighting.exposure`
  as a per-scene trim. With `mood=none` the scene's exposure applies alone.
