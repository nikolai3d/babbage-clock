# Testing

Four layers, each answering a different question.

| Layer          | Question                                      | Command            | Where                                      |
| -------------- | --------------------------------------------- | ------------------ | ------------------------------------------ |
| **Unit**       | Is the maths and the data right?              | `npm run test`     | `src/**/*.test.ts`                         |
| **E2E**        | Does the real app boot, render and respond?   | `npm run test:e2e` | `e2e/*.spec.ts`                            |
| **Screenshot** | Does it still _look_ right?                   | `npm run test:e2e` | `e2e/screenshots.spec.ts`                  |
| **a11y**       | Is it usable without sight, a mouse or a GPU? | `npm run test:e2e` | `e2e/a11y.spec.ts`, `e2e/fallback.spec.ts` |

Plus an on-demand **demo capture** (`npm run capture:demo`) that records a video
tour to `artifacts/`. It is not part of CI.

`npm run ci` runs typecheck, lint, unit tests and build. E2E runs as a separate
CI job, because it needs a browser and takes longer.

---

## Rules that will save you an hour

1. **Always pass `--reporter=line`.** Playwright's default `html` reporter
   starts a web server when a run fails and waits for a browser to connect. In
   a terminal, CI job or agent session that simply hangs. The `test:e2e` scripts
   already pass it and `playwright.config.ts` defaults to it — don't undo either.
2. **Never use watch mode** (`vitest` without `--run`, `playwright --ui`) in an
   automated session.
3. **Wrap long commands in a timeout** and redirect to a file rather than piping
   through `tail`:
   ```bash
   timeout 600 npm run test:e2e > /tmp/e2e.log 2>&1; tail -60 /tmp/e2e.log
   ```
4. **Take your own port rather than clearing someone else's.** The default is
   4173; `E2E_PORT` moves it. If several agents or checkouts are working in the
   same repo at once, a blanket `pkill -f playwright` kills their in-flight runs
   and the failures look exactly like flaky tests:

   ```bash
   E2E_PORT=4291 npm run test:e2e            # your own port, nobody else's
   lsof -ti:4291 -sTCP:LISTEN | xargs kill   # only if *your* run died
   ```

   `npm run test:e2e:docker` sidesteps the question entirely, and is how CI runs.

---

## Unit tests (Vitest)

```bash
npm run test                     # single run
npm run test -- countdown        # filter by file name
npm run test -- -t "carry"       # filter by test name
```

They run in a plain Node environment with no DOM and no WebGL: `src/scene/` and
`src/time/` never import three.js, and building a three.js scene graph does not
need a GL context. Anything that needs actual pixels belongs in the e2e layer.

---

## E2E tests (Playwright)

```bash
npm run test:e2e                          # whole suite
npm run test:e2e -- boot.spec.ts          # one file
npm run test:e2e -- -g "advances"         # by title
npm run test:e2e -- --debug               # step through (interactive only)
npm run test:e2e -- --trace on            # force a trace for every test
```

The config starts its own server (`npm run build && npm run preview`) on port
4173, so you do not need a dev server running. Set `E2E_PORT` to change it.

### Running the specs against a deployed site

`npm run test:e2e:live` runs `boot.spec.ts` against an already-running site
instead of a local preview server — no `webServer`, no screenshots. This is the
post-deploy smoke check; the deploy workflow runs it against the published URL.

```bash
E2E_BASE_URL=https://nikolai3d.github.io/babbage-clock/ npm run test:e2e:live
```

Two details make the same specs work against both targets, and both are easy to
undo by accident:

- `E2E_BASE_URL` is normalised to end in `/`. Playwright resolves a spec's path
  against it with `new URL()`, which drops a trailing segment that has no slash.
- `appUrl()` returns `./?…`, not `/?…`. A leading slash resolves to the domain
  root, which throws away the `/babbage-clock/` project-page base path and makes
  every request 404.

See [deploy.md](deploy.md) for the base-path rules this exists to police.

### The mobile project

`playwright.config.ts` defines two projects:

| Project           | Viewport       | Runs                               |
| ----------------- | -------------- | ---------------------------------- |
| `chromium`        | 1280x720       | everything except `mobile.spec.ts` |
| `mobile-portrait` | 412x915, touch | `mobile.spec.ts` only              |

```bash
npm run test:e2e -- --project=mobile-portrait
```

The split is deliberate and the second half of it matters more than the first:
**the mobile project runs one spec, not the whole suite again.** E2E runs on a
two-core runner where image-based lighting already makes a frame expensive, so
re-running boot, scene switching and time assertions at a second viewport would
roughly double the job to re-prove things that do not depend on the viewport.
`mobile.spec.ts` covers only what does: the aspect-aware framing, the bottom
sheet, touch orbit and pinch, the automatic quality tier, and one portrait
baseline.

Two details of the mobile context are load-bearing:

- `deviceScaleFactor` is pinned to **1**, not the Pixel 7's real 2.625. A
  baseline is compared pixel for pixel, and a 2.6x image is seven times the
  pixels to rasterise, diff and store. What the quality tier does with a high
  device pixel ratio is a unit test (`src/app/quality.test.ts`) and needs no
  browser.
- `isMobile` and `hasTouch` are on, which is what gives the touch event model
  and `(pointer: coarse)`. Touch drags go in through CDP
  (`Input.dispatchTouchEvent`) because Playwright's `touchscreen` can only tap.

### What CI cannot tell you: the real-device checklist

**Nothing below has been verified on hardware.** Chromium's device emulation
gives a viewport, the touch event model and the pointer media queries; it does
not give a mobile GPU, a thermal envelope, iOS's memory ceiling or WebKit. The
e2e run is on SwiftShader on a Linux runner, which is a different machine in
every way that mobile performance depends on.

Run this by hand before claiming the site is good on phones:

**Android (Chrome), iOS (Safari) — both, in portrait and landscape:**

- [ ] The countdown reading is legible on first paint, with no interaction and
      no rotation.
- [ ] One finger orbits the mechanism; two fingers pinch-zoom and stay within
      the scene's framing limits.
- [ ] A swipe that starts on the settings sheet scrolls the sheet, and a swipe
      that starts anywhere else does not scroll or bounce the page.
- [ ] The settings sheet never covers the readout, and its bottom row of
      controls sits above the home indicator.
- [ ] Focusing the date field does not zoom the page (the 16px input font).
- [ ] Rotating the device re-frames the mechanism; rotating it after orbiting
      by hand leaves the viewer's own pose alone.
- [ ] `?quality=high` and `?quality=low` visibly differ, and the drawer's
      Render quality control switches between them without a reload.

**iOS specifically — the two failure modes that do not reproduce anywhere else:**

- [ ] Leave the tab open for ten minutes on a mid-range phone: the device
      should stay warm rather than hot, and the frame rate should hold. The low
      tier caps frames at 30 for exactly this.
- [ ] Switch away to three or four other apps and come back. iOS kills greedy
      WebGL tabs, and a killed context must come back through the
      `webglcontextrestored` path with the quality tier and framing re-applied
      (`ClockRenderer.refresh`), not as a blank canvas.
- [ ] Check memory in Safari's Web Inspector while switching lighting moods
      repeatedly; the prefiltered environment maps are the largest allocation
      the app makes.

### Debugging a failure

Failures leave everything you need under `test-results/<test-name>/`:

```bash
npx playwright show-trace test-results/<test-name>/trace.zip
```

The trace has a DOM snapshot, console output, network log and a filmstrip for
each step. Videos (`video.webm`) are kept on failure too. In CI these are
uploaded as the `e2e-artifacts` artifact on the failed run.

### How the specs observe the app

Specs assert on **state, not pixels**, wherever they can. `?testApi=1` installs
`window.__clock`:

```ts
window.__clock.digits(); // number[] currently on the rings
window.__clock.sceneId(); // active scene id
window.__clock.countdown(); // CountdownParts
window.__clock.target(); // CountdownTarget
window.__clock.renderer(); // { webgl2, frames, drawCalls, triangles, ... }
window.__clock.hooks(); // the test hooks in force
window.__clock.now(); // the effective clock reading
```

`renderer().drawCalls > 0` is the important one: it is how the suite proves the
scene actually reached the GPU, rather than a blank canvas that would make a
screenshot pass for the wrong reason.

Time assertions are deliberately **loose** — "the readout changed", never an
exact string — so the suite does not encode the countdown's current formatting.

### If you rename something in the UI

Every DOM selector the suite uses is declared once, in `SELECTOR` in
`e2e/support/app.js`. A class or id rename is a one-line fix there rather than a
hunt through four spec files.

Two helpers exist because the UI needs driving before it can be asserted on:

- `waitForLoadingScreen(page)` — the loading screen is authored in `index.html`
  so it paints before any JavaScript, and covers the canvas until boot
  finishes. `gotoApp()` already waits it out.
- `openSettings(page)` — the scene picker lives in the settings drawer, which is
  collapsed by default. Its controls cannot be clicked until this runs.

---

## Determinism hooks

Test-only query parameters, implemented in `src/app/testHooks.ts`. **Every one
is off unless its parameter is present**, so production behaviour is unchanged;
`src/app/testHooks.test.ts` asserts that.

| Parameter               | Effect                                                                   |
| ----------------------- | ------------------------------------------------------------------------ |
| `?mockNow=<epoch\|ISO>` | Pins the clock. Accepts `1767225600000` or `2026-01-01T00:00:00Z`.       |
| `?mockNowMode=frozen`   | Default. `now()` never moves — every frame is identical.                 |
| `?mockNowMode=advance`  | Starts pinned, then advances with real monotonic time (genuine ticking). |
| `?nomotion=1`           | Disables camera damping, gear rotation and ring easing.                  |
| `?nosync=1`             | Skips the network clock correction, for hermetic runs.                   |
| `?testApi=1`            | Installs `window.__clock`.                                               |

`?quality=low` and `?quality=high` are **not** test hooks — they are a real
viewer-facing setting that pins the render tier, documented here because the
suite depends on them. Anything else, including its absence, means `auto`.

`deterministicOptions()` pins `quality=high`, and that is load-bearing for the
screenshot layer. Left automatic, the tier is chosen partly from
`navigator.hardwareConcurrency`: 2 on a CI runner, 8 or more on a developer's
machine. The tiers do not draw the same background — the low one substitutes a
mood's authored gradient for its HDR panorama — so an unpinned baseline would
be a picture of whatever machine last regenerated it. Only the spec that tests
the heuristic itself passes `quality: 'auto'`.

The hooks are orthogonal: setting one never implies another, and a unit test
asserts it.

`?nosync` matters more than it looks. On boot the app corrects its clock against
external time services, and its last-resort provider probes the app's own origin
several times. Left on, that makes every spec depend on the public internet, and
under parallel workers the repeated same-origin probes can exhaust Chromium's
per-host connection pool and starve the page's own module loads — which shows up
as a page that never finishes booting. `gotoApp()` therefore sets `?nosync` by
default. One spec (`degrades quietly when the time-sync services are
unreachable`) deliberately opts back in with `noSync: false` to cover the real
path.

`mockNow` is an adapter satisfying the existing `TimeSource` interface from
`src/time/target.ts`, so it composes with whatever that module becomes.

Try it by hand against a dev server:

```
http://localhost:5173/?mockNow=2026-06-15T12:00:00Z&nomotion=1&testApi=1&scene=slate-orrery
```

---

## Screenshots

Baselines live in `e2e/__screenshots__/screenshots.spec.ts/` and are **committed**.

Every shot is taken in fully deterministic mode: frozen clock, absolute
`?target=`, `?nomotion=1`, fixed 1280×720 viewport, `deviceScaleFactor: 1`, UTC
and `en-US`. Comparison allows `maxDiffPixelRatio: 0.005` for raster noise.

That tolerance is calibrated, not guessed: recolouring a single material slot
moves about 4% of the frame, so 0.5% keeps roughly an order of magnitude of
margin below the smallest change worth catching. **If a screenshot test fails,
regenerate the baseline — do not raise the tolerance.**

### Baselines are Linux/SwiftShader artefacts

**The committed baselines are canonical and are produced inside the official
Playwright container** — the same image CI runs in. That pins the browser build,
the system fonts and the graphics stack together.

This is why the screenshot specs **skip automatically on macOS**. Without that,
every macOS developer would generate a second, conflicting set of images and the
baselines would churn forever. Snapshot filenames carry no platform suffix,
which makes committing a mac-rendered baseline impossible by accident.

### Regenerating the baselines

You need this whenever you deliberately change how the scene looks — new
geometry, new materials, new lighting, a camera tweak.

```bash
npm run test:e2e:docker:update      # regenerate every baseline
```

To regenerate a subset:

```bash
scripts/e2e-docker.sh --update-snapshots -g "slate-orrery"
```

Then review and commit the changed PNGs:

```bash
git status e2e/__screenshots__
git add e2e/__screenshots__
```

**Always look at the new images before committing them.** The point of the
baseline is to make an unintended visual change impossible to merge quietly; a
blind `--update-snapshots` throws that away.

Requirements: Docker running. The script picks the image tag from the installed
`@playwright/test` version, mounts the repo, and shadows `node_modules` with a
named volume so it never overwrites your host's macOS binaries.

To run (not update) the suite exactly as CI does:

```bash
npm run test:e2e:docker
```

To force screenshots to run on your own machine anyway — useful for a quick
local look, never for committing — set `PW_SCREENSHOTS=1`:

```bash
PW_SCREENSHOTS=1 npm run test:e2e -- screenshots.spec.ts
```

### Upgrading Playwright

Bump `@playwright/test` in `package.json` **and** the container image tag in
`.github/workflows/ci.yml` together. A CI step compares them and fails with an
explicit message if they drift. A browser upgrade usually shifts antialiasing,
so expect to regenerate the baselines in the same commit.

### Checking the safety net still works

Perturb something visual, confirm the screenshot test fails, then revert:

```bash
# e.g. change `ring:` colour in src/scene/scenes/copperPadlock.ts
npm run test:e2e:docker -- -g "copper-padlock"   # expect FAIL
git checkout src/scene/scenes/copperPadlock.ts
```

---

## WebGL in headless CI

Headless Chromium on a CI runner has no GPU. Without help it refuses to give out
a WebGL2 context at all, the app logs `WebGL2 unavailable`, and the canvas
renders empty — which would make every screenshot silently agree with a blank
baseline.

`e2e/support/env.ts` forces ANGLE's SwiftShader backend:

```
--use-gl=angle --use-angle=swiftshader --enable-unsafe-swiftshader
```

`--enable-unsafe-swiftshader` is required from Chromium 120, which stopped
allowing the SwiftShader fallback for WebGL implicitly. The flags are applied on
developer machines too, so a real GPU cannot produce frames CI can never match.

Three assertions in `e2e/boot.spec.ts` guard this and will fail loudly rather
than degrade quietly:

- a `webgl2` context exists and reports `WebGL 2.0`;
- the app never logged the `WebGL2 unavailable` warning;
- `renderer().drawCalls > 0` and `triangles > 0`.

The passing run prints the backend, e.g.:

```
[e2e] WebGL2 renderer: ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (LLVM 10.0.0) (0x0000C0DE)), SwiftShader driver)
```

If e2e goes red with a blank canvas, check that line first.

---

## Accessibility and fallback specs

`e2e/a11y.spec.ts` runs axe-core against the app in each of its states (drawer
closed and open, timezone listbox open, a toast showing, the loading screen, and
at a 200%-zoom viewport), checks the live-region cadence against a real ticking
clock, and walks the entire settings flow with nothing but the keyboard.

`e2e/fallback.spec.ts` forces the two ways the picture can fail:

- **No WebGL** — `disableWebGL(page)` (in `e2e/support/app.ts`) patches
  `HTMLCanvasElement.prototype.getContext` to return null for any `webgl*`
  context before any script runs, which is the real failure: `WebGLRenderer`
  throws out of its constructor. Note that three.js logs a `console.error` on
  that path, so these specs do not assert an empty console.
- **Context loss** — `WEBGL_lose_context` on the app's own context, which fires
  the browser's real `webglcontextlost`. **Keep the extension handle**: once the
  context is lost, `getExtension` on it returns null, so `restoreContext` can
  never be found by a second lookup.

Reduced motion is exercised with `page.emulateMedia({ reducedMotion: 'reduce' })`
both before navigation and mid-session. `renderer().motion` is the _effective_
setting and `hooks().motion` is the URL parameter, so comparing them proves the
media query reached the renderer rather than the query string. See
**[accessibility.md](accessibility.md)**.

## Demo capture

```bash
npm run capture:demo
```

Records a scripted tour — boot, several live ticks, an orbit drag, a scene
switch — to `artifacts/babbage-clock-demo.webm`. It uses
`?mockNowMode=advance` so the countdown starts from a known, nicely-shaped value
and then ticks for real, and it leaves motion **on**: this is the one place the
gear rotation and easing are the point.

It lives in its own config (`playwright.capture.config.ts`, specs in
`capture/`), so a bare `npx playwright test` can never pick it up and slow a
pull request down.

---

## CI layout

`.github/workflows/ci.yml` has two jobs, run in parallel on every PR:

- **ci** — `npm run ci` (typecheck, lint, unit tests, build) on `ubuntu-latest`.
- **e2e** — the Playwright suite inside `mcr.microsoft.com/playwright:*-noble`.
  Browsers are preinstalled in the image, so there is nothing to download or
  cache. On failure it uploads `test-results/` (screenshot diffs, videos,
  traces) as the `e2e-artifacts` artifact.

---

## Adding tests

- **New scene?** Nothing to do for `e2e/scenes.spec.ts` — it enumerates the
  registry, so a new scene is automatically checked for "renders, draws, packs
  the right number of digits". Add a screenshot baseline if it deserves one.
- **New time behaviour?** Prefer a unit test in `src/time/`. Keep e2e assertions
  about time loose.
- **New rendering?** Add a screenshot only if a state assertion cannot express
  it. State assertions say why they failed; images only say that they did.
