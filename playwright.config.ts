import { defineConfig, devices } from '@playwright/test';
import {
  CHROMIUM_GPU_ARGS,
  DETERMINISTIC_CONTEXT,
  E2E_BASE_URL,
  E2E_LOCAL_BASE_URL,
  E2E_SERVER_COMMAND,
  MOBILE_PORTRAIT_CONTEXT,
} from './e2e/support/env';

/**
 * End-to-end configuration.
 *
 * Three things here are load-bearing and should not be "tidied up":
 *
 * 1. **The reporter is `line`, never `html`.** The HTML reporter starts a web
 *    server when a run fails and waits for a browser to connect, which hangs
 *    whatever invoked it — CI jobs and agents included. `line` prints and exits.
 * 2. **Software rendering is forced everywhere** (see `CHROMIUM_GPU_ARGS`), so a
 *    developer's GPU cannot produce frames that CI's SwiftShader will not.
 * 3. **Snapshots have no platform suffix.** Baselines are Linux/SwiftShader
 *    artefacts produced in the Playwright container; see `docs/testing.md`.
 */
export default defineConfig({
  testDir: './e2e',
  // `support/` holds helpers, not specs.
  testMatch: '**/*.spec.ts',

  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  // Software rendering is CPU-bound: more workers than cores makes every frame
  // slower and turns timing-sensitive specs flaky. Locally Playwright's own
  // heuristic is left alone, hence the conditional spread.
  ...(process.env.CI ? { workers: 2 } : {}),

  timeout: 45_000,
  expect: {
    timeout: 10_000,
    toHaveScreenshot: {
      // SwiftShader is a deterministic software rasteriser and CI runs the same
      // container, so the observed noise floor is ~0. The slack is for CPU
      // differences between runners, not for real visual change.
      //
      // Calibration, learned the hard way: the original 0.5% was derived from a
      // material recolour (~4% of the frame) — a whole-frame change. Digit
      // glyphs are small: changing FOUR of the seven ring digits measured just
      // *under* 0.5%, so the suite passed against a stale baseline showing the
      // wrong time, and --update-snapshots then left that baseline in place
      // (Playwright only rewrites on failure). 0.15% puts a single-digit change
      // above the line for the full-frame shots; the reading-line close-up in
      // screenshots.spec.ts is the primary digit guard on top of that.
      // Raising this hides regressions — if a legitimate visual change lands,
      // regenerate the baselines instead (delete the PNGs first; a
      // stale-but-passing baseline is never rewritten).
      maxDiffPixelRatio: 0.0015,
      threshold: 0.2,
      animations: 'disabled',
      caret: 'hide',
    },
  },

  // Baselines are canonical on Linux/SwiftShader. Omitting the platform token
  // is deliberate: it stops macOS developers from silently committing a second,
  // conflicting set. `docs/testing.md` documents regeneration via Docker.
  snapshotPathTemplate: '{testDir}/__screenshots__/{testFileName}/{arg}{ext}',

  reporter: process.env.CI ? [['line'], ['github']] : [['line']],

  use: {
    baseURL: E2E_BASE_URL,
    ...DETERMINISTIC_CONTEXT,
    trace: 'retain-on-failure',
    video: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },

  projects: [
    {
      name: 'chromium',
      // The mobile spec asserts on a portrait viewport, so it belongs to the
      // project that provides one and nowhere else.
      testIgnore: '**/mobile.spec.ts',
      use: {
        ...devices['Desktop Chrome'],
        ...DETERMINISTIC_CONTEXT,
        channel: 'chromium',
        launchOptions: { args: CHROMIUM_GPU_ARGS },
      },
    },
    {
      /**
       * A portrait phone.
       *
       * Deliberately **one** project running **one** spec rather than the whole
       * suite a second time. E2E runs on a two-core runner where image-based
       * lighting already makes a frame expensive, so a mobile project that
       * duplicated the desktop coverage would roughly double the job for
       * assertions that are not viewport-dependent. What is viewport-dependent
       * — framing, the bottom sheet, touch input — lives in `mobile.spec.ts`.
       */
      name: 'mobile-portrait',
      testMatch: '**/mobile.spec.ts',
      use: {
        ...devices['Pixel 7'],
        ...MOBILE_PORTRAIT_CONTEXT,
        channel: 'chromium',
        launchOptions: { args: CHROMIUM_GPU_ARGS },
      },
    },
  ],

  webServer: {
    // The production bundle is what ships, so that is what is tested. Building
    // here keeps `dist/` from going stale between runs.
    command: E2E_SERVER_COMMAND,
    url: E2E_LOCAL_BASE_URL,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    stdout: 'ignore',
    stderr: 'pipe',
  },
});
