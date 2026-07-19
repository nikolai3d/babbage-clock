# Lighting moods (IBL presets)

A **mood** is a complete lighting look: an HDR panorama used for image-based
lighting, a background treatment, a rig of analytic lights and a tone-mapping
grade. Five ship today — `day`, `sunny-day`, `night`, `steampunk-workshop` and
`busy-street` — plus `none`, which turns IBL off and leaves the scene lit by the
lights it declares itself.

Moods are **content, not code**, the same way scenes are. A mood is a folder
under `assets/ibl/`; adding one is adding a folder, not editing the renderer.

Moods and scenes are **orthogonal**. A mood only ever changes lighting,
background and grade, so any look renders under any mood. The viewer picks one
in the settings panel or with `?mood=`, and it round-trips through share links.
`?mood=` absent means "whatever the scene declares".

## Anatomy of a preset

```
assets/ibl/steampunk-workshop/
  preset.json          the manifest — everything below is described here
  fireplace_1k.hdr     the panorama the manifest names
```

<!-- prettier-ignore -->
```jsonc
{
  "id": "steampunk-workshop",       // must equal the folder name
  "name": "Steampunk workshop",     // shown in the picker
  "description": "…",

  "environment": {
    "file": "fireplace_1k.hdr",     // resolved inside this folder
    "format": "rgbe",               // "rgbe" (.hdr) | "exr" | "ktx2"
    "intensity": 1.35,              // scene.environmentIntensity
    "rotation": 0.4                 // radians about Y — aims the map
  },

  "background": {
    "mode": "environment",          // "environment" | "fallback"
    "blurriness": 0.55,             // scene.backgroundBlurriness, 0-1
    "intensity": 0.45,              // scene.backgroundIntensity
    "fallback": {                   // used when the panorama is not shown
      "kind": "gradient",           // "gradient" | "color"
      "top": "#2a1a10",
      "bottom": "#0a0706",
      "power": 1.5                  // > 1 pushes the light band upward
    }
  },

  "grade": {
    "exposure": 1.15,               // multiplied by the scene's own exposure
    "toneMapping": "aces"           // aces | agx | neutral | reinhard | cineon | linear | none
  },

  "fog": { "color": "#150d09", "near": 11, "far": 30 },   // optional

  "sceneLightScale": 0,             // how much of the scene's own rig survives, 0-1

  "lights": [                       // the analytic rig — see below
    { "type": "directional", "name": "lamp-key", "color": "#ffd7a8",
      "intensity": 1.25, "position": [3, 4, 6] },
    { "type": "point", "name": "gaslight", "color": "#ffa64d", "intensity": 26,
      "position": [-3.2, 2.4, 3.4], "distance": 18, "decay": 2 }
  ],

  "source": {                       // not optional — see "Provenance"
    "title": "Fireplace",
    "authors": ["Greg Zaal"],
    "provider": "Poly Haven",
    "url": "https://polyhaven.com/a/fireplace",
    "licence": "CC0-1.0",
    "resolution": "1k",
    "notes": "…"
  }
}
```

Colours are `#rrggbb` strings so a manifest reads like a palette. Light types are
`ambient`, `hemisphere`, `directional`, `point` and `spot`; every field with a
sensible default may be omitted. The schema is parsed and validated by
`src/render/ibl/manifest.ts`, which reports **every** problem at once and names
the offending field (`lights[2].position: missing or not a [x, y, z] triple`).

## Why a rig as well as a map

A prefiltered panorama is an enormous, very soft area light coming from every
direction at once. It gives beautiful ambient and correct-looking reflections,
and almost no shadow definition — under IBL alone the mechanism goes flat.

So every mood pairs its map with a small analytic rig that supplies what the map
cannot: a real sun for `sunny-day` (hard shadows, crisp speculars), a warm
gaslight and a forge glow for the workshop, a cool rim plus a deliberate
`reading-key` for `night`, four small coloured sources for `busy-street`.

`sceneLightScale` is how the two halves avoid doubling up. It is `0` in every
shipped mood: while a mood is active it owns the lighting, and the scene's own
`lighting.ambient` / `lighting.directional` are scaled to nothing. Those lights
are not deleted — they are the scene's `none`-mood fallback, and scaling rather
than removing them is what lets a mood be reverted in a single frame.

## Background independent of lighting

`background.mode` decides what the viewer looks at; the panorama lights the
scene either way.

- `environment` — the panorama itself, optionally blurred (`blurriness`) and
  dimmed (`intensity`).
- `fallback` — the flat colour or vertical gradient in `background.fallback`.

A **scene** overrides this with `lighting.environment.showAsBackground`, which
is how the copper padlock keeps its signature dark vignette under every mood
while still being lit by the mood's map:

```ts
// src/scene/scenes/copperPadlock.ts
environment: { preset: 'steampunk-workshop', showAsBackground: false },
```

`slate-orrery` sets `showAsBackground: true` and shows its panorama, so both
paths are exercised by shipped data rather than only by tests. A scene may also
set `lighting.environment.intensity` as a multiplier on the mood's own.

## How switching works

`ClockRenderer.setScene` rebuilds the view and then calls
`EnvironmentController.apply`. Everything a mood owns — `scene.environment`,
the background, `scene.fog`, the rig and the renderer's tone mapping and
exposure — is written in **one synchronous block** in `commit`, or not at all.
There is no frame in which the environment comes from one mood and the lights
from another.

Loading is asynchronous; committing is not:

- **Mood already prefiltered** — committed inside `apply`, in the same frame.
  The PMREM cache means the second visit to a mood is free.
- **Mood not resident** — the previously committed mood is re-stated over the
  freshly built scene and stays whole on screen until the new one is ready.
  Nothing is half-applied, and a non-default preset never delays first paint.
- **Mood fails to load** — a warning, and the current mood keeps rendering.
- **Viewer switches again mid-load** — the stale result is discarded, not
  committed over the mood actually chosen.

v1 uses a hard cut. A ~0.5 s crossfade is a deliberate follow-up, not an
oversight: the environment map itself cannot be cross-dissolved without a second
environment slot, and ramping intensity alone across a texture swap looks worse
than the cut it replaces.

`<html data-ibl>` reports `loading`, `ready`, `none` or `error`. The e2e suite
should wait on `html[data-ibl="ready"]` before taking a screenshot rather than
racing an HDR download.

## Resource ownership

`EnvironmentLibrary` prefilters each panorama through `PMREMGenerator` exactly
once per session and caches the render target by preset id. It also:

- disposes the decoded float panorama the moment PMREM has consumed it,
  including when prefiltering throws;
- shares one load between concurrent callers;
- throws away — rather than caching — a result that lands after `dispose()`;
- releases every cached render target and the generator in `dispose()`;
- settles a load still in flight when `dispose()` lands by rejecting it with
  `EnvironmentDisposedError` instead of pending forever — KTX2's terminated
  worker pool would otherwise drop the job silently;
- disposes on arrival — never orphans — a texture the decoder delivers after
  that rejection.

`EnvironmentController` owns the rig, the generated gradient backdrop and the
grade, and disposes each when the mood changes or the renderer goes away. The
backdrop is regenerated only when the mood changes, not on every scene switch.

Verified two ways: `src/render/ibl/library.test.ts` and
`src/render/lighting.test.ts` assert the conservation properties headlessly, and
the counts were confirmed in a real browser by instrumenting
`WebGL2RenderingContext` — live textures, renderbuffers and framebuffers were
identical after 20, 40 and 80 further mood switches.

## Adding a mood

1. Create `assets/ibl/<id>/` and drop the panorama in. 1k `.hdr` is the target;
   the budget is **3 MB per preset**, and a test enforces it.
2. Write `preset.json` with `"id"` equal to the folder name. Fill in `source`
   honestly — the tests will fail without an author, a licence and an `https`
   URL.
3. Add `<id>` to `EnvironmentPresetId` in `src/scene/types.ts` and to
   `ENVIRONMENT_PRESETS` in `src/scene/environment.ts` so the picker and
   `?mood=` know about it. A test asserts those two lists and the folders on
   disk agree.

That is the whole procedure. No render code changes: `import.meta.glob` picks
the folder up at build time, and each panorama and manifest becomes its own lazy
chunk, fetched only when a viewer selects that mood.

### Choosing and grading a map

The shipped moods were picked by measuring candidates rather than by eye. For
each candidate the solid-angle-weighted mean radiance, the R/B ratio and the
peak-to-mean ratio were computed from the decoded HDR; `environment.intensity`
was then set so the five moods land in a deliberate spread of ambient levels
instead of whatever each photograph happened to be exposed at. Each manifest's
`source.notes` records the numbers behind its own settings.

The look was then checked by evaluating the copper padlock's actual materials
under each mood — environment plus rig, graded and ACES-tone-mapped — to confirm
no metal blows out or goes dead black and that the dark numerals keep their
contrast against the copper drum. `night` was the case that drove a change: it
gained a dedicated `reading-key` light, because the map alone left the reading
line too dark to read.

### Formats

`rgbe` (`.hdr`), `exr` and `ktx2` (UASTC HDR) are implemented; every decoder is
dynamically imported so a mood nobody selects costs nothing. The `ktx2` path
uses the same Basis transcoder as the material pipeline — synced from `three`
into `public/basis/` by `scripts/sync-basis-transcoder.mjs` on `predev` and
`prebuild`, fetched at runtime from a URL joined onto `import.meta.env.BASE_URL`
(see `docs/materials.md`). Unlike materials there is no uncompressed fallback: a
preset names exactly one panorama, so a `.ktx2` that cannot be transcoded
rejects loudly and the previous mood stays applied.

The `.ktx2` path is exercised in CI end to end: `assets/ibl/test-uastc-hdr/`
holds a 1.3 kB genuine UASTC-HDR container (a three.js r182 sample, MIT), and
`e2e/ibl.spec.ts` boots the app with the `?moodOverride=` test hook pointing at
it, asserting the transcoder is fetched and the mood commits. Folders prefixed
`test-` are fixtures, not moods — the picker and `?mood=` exclude them, and
`src/render/ibl/manifest.test.ts` holds them to fixture rules (tiny, honest
provenance, genuinely the format they claim) instead of the shipped-mood rules
above.

The shipped moods are still 1k `.hdr`; converting them to KTX2/UASTC-HDR to cut
the payload is a follow-up. Encode with `toktx --encode uastc --uastc_quality 3
--zcmp 19 --assign_oetf linear` (or `basisu -uastc_hdr`; exact flags vary
across KTX-Software/basisu releases, so re-verify against the version you run)
and set `"format": "ktx2"` in the manifest — then check the mood by eye. Two
things to look for: UASTC HDR is lossy where `.hdr` was not, and a KTX2
container's orientation cannot be flipped at load time (the same rule
`scripts/compress-material.mjs` bakes in for materials), so a naively converted
panorama can come out vertically flipped against its `.hdr` source — a sun
below the horizon is this bug, not a grading choice.

## Provenance and licences

Every panorama must record where it came from. `source` is a required block, and
`assets/ibl/LICENSES.md` summarises all of them. All five shipped maps are
**CC0-1.0** from Poly Haven, by Greg Zaal (and Jarod Guest on the sunny-day sky
edit). CC0 asks for no attribution; it is recorded anyway so a later bead can
tell what is safe to replace.
