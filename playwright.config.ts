import { defineConfig, devices } from '@playwright/test';
import {
  CHROMIUM_GPU_ARGS,
  DETERMINISTIC_CONTEXT,
  E2E_BASE_URL,
  E2E_SERVER_COMMAND,
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
      // Calibration: recolouring one material slot moves ~4% of the frame, so
      // 0.5% keeps roughly an order of magnitude of margin below the smallest
      // change worth catching. Raising this hides regressions — if a legitimate
      // visual change lands, regenerate the baselines instead.
      maxDiffPixelRatio: 0.005,
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
      use: {
        ...devices['Desktop Chrome'],
        ...DETERMINISTIC_CONTEXT,
        channel: 'chromium',
        launchOptions: { args: CHROMIUM_GPU_ARGS },
      },
    },
  ],

  webServer: {
    // The production bundle is what ships, so that is what is tested. Building
    // here keeps `dist/` from going stale between runs.
    command: E2E_SERVER_COMMAND,
    url: E2E_BASE_URL,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    stdout: 'ignore',
    stderr: 'pipe',
  },
});
