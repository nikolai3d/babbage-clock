import { defineConfig, devices } from '@playwright/test';
import {
  CHROMIUM_GPU_ARGS,
  DETERMINISTIC_CONTEXT,
  E2E_BASE_URL,
  E2E_SERVER_COMMAND,
} from './e2e/support/env';

/**
 * Demo capture — `npm run capture:demo`.
 *
 * A separate config, not a project inside `playwright.config.ts`, so the
 * capture can never be picked up by a bare `npx playwright test` and slow down
 * a pull request. It records video unconditionally and is meant to be run on
 * demand.
 */
export default defineConfig({
  testDir: './capture',
  testMatch: '**/*.capture.ts',

  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 180_000,
  reporter: [['line']],

  // Deliverables, not test debris.
  outputDir: './artifacts/demo',

  use: {
    baseURL: E2E_BASE_URL,
    ...devices['Desktop Chrome'],
    ...DETERMINISTIC_CONTEXT,
    channel: 'chromium',
    launchOptions: { args: CHROMIUM_GPU_ARGS },
    video: { mode: 'on', size: { width: 1280, height: 720 } },
    trace: 'off',
  },

  webServer: {
    command: E2E_SERVER_COMMAND,
    url: E2E_BASE_URL,
    reuseExistingServer: true,
    timeout: 120_000,
    stdout: 'ignore',
    stderr: 'pipe',
  },
});
