import { defineConfig, devices } from '@playwright/test';
import { CHROMIUM_GPU_ARGS, DETERMINISTIC_CONTEXT, E2E_BASE_URL } from './e2e/support/env';

/**
 * Post-deploy smoke — `E2E_BASE_URL=<url> npm run test:e2e:live`.
 *
 * Runs the boot spec against a *deployed* site instead of a local preview
 * server. It is the acceptance test for a deploy: a workflow file that looks
 * correct proves nothing, and the failure mode this guards against — asset
 * URLs that ignore the project-page base path — is invisible everywhere except
 * production, because `vite preview` serves from the domain root.
 *
 * `boot.spec.ts` is exactly the right spec for this and needs no live-only
 * variant. It already asserts the two things that matter: every own-origin
 * request returned < 400 (so no base-path 404s), and the page acquired a real
 * WebGL2 context and issued draw calls (so the scene genuinely initialised
 * rather than rendering a blank canvas).
 *
 * Three differences from `playwright.config.ts`:
 *
 * 1. **No `webServer`.** The site under test is already running; starting a
 *    local one would silently test the wrong thing.
 * 2. **Boot spec only.** The screenshot baselines are Linux/SwiftShader
 *    artefacts pinned to the Playwright container (see docs/testing.md);
 *    comparing them against a CDN-served page adds no signal and would make
 *    deploys fail on pixel noise. `countdown`/`scenes` are behaviour already
 *    covered pre-merge — this job's question is narrower: *did the deployed
 *    bundle load and boot*.
 * 3. **One retry, and a failure cap.** This is the only suite whose network is
 *    real, so a single retry absorbs a transient CDN hiccup. The cap is the
 *    more important half: when a deploy is genuinely broken *every* test fails,
 *    and without it the job would spend its whole timeout re-running an
 *    already-answered question instead of reporting the breakage. The deploy
 *    workflow separately waits for the site to return 200 before getting here,
 *    so slow propagation is not what these retries are for.
 */
export default defineConfig({
  testDir: './e2e',
  testMatch: 'boot.spec.ts',

  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: 1,
  maxFailures: 3,
  workers: 2,

  // Roomier than the hermetic suite: this run crosses the public internet and
  // a CDN rather than loopback.
  timeout: 60_000,
  expect: { timeout: 20_000 },

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
});
