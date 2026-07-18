# Testing

Three layers, each answering a different question.

| Layer          | Question                                    | Command            | Where                     |
| -------------- | ------------------------------------------- | ------------------ | ------------------------- |
| **Unit**       | Is the maths and the data right?            | `npm run test`     | `src/**/*.test.ts`        |
| **E2E**        | Does the real app boot, render and respond? | `npm run test:e2e` | `e2e/*.spec.ts`           |
| **Screenshot** | Does it still _look_ right?                 | `npm run test:e2e` | `e2e/screenshots.spec.ts` |

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
4. **Free the port first** if a previous run died:
   ```bash
   lsof -ti:4173 | xargs kill -9 2>/dev/null; pkill -9 -f playwright; true
   ```

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
| `?testApi=1`            | Installs `window.__clock`.                                               |

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
and `en-US`. Comparison allows `maxDiffPixelRatio: 0.02` for raster noise.

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
