import { expect } from '@playwright/test';
import type { ConsoleMessage, Page } from '@playwright/test';
import type { RendererState } from '../../src/app/testHooks.js';

/**
 * Helpers for driving the app.
 *
 * Specs assert on `window.__clock` (installed by `?testApi`) rather than on
 * pixels wherever they can: state assertions say *why* something failed, and
 * they do not need a screenshot baseline to be meaningful.
 */

/** A time far enough from any real "now" that a stale pin is obvious. */
export const PINNED_NOW = Date.UTC(2026, 5, 15, 12, 0, 0);
/** Roughly 200 days after {@link PINNED_NOW}, so every ring has a digit on it. */
export const PINNED_TARGET = '2027-01-01T00:00:00Z';

export interface AppOptions {
  /** Scene id for `?scene=`. Omit to exercise the default. */
  readonly scene?: string;
  /** Countdown target for `?target=`. */
  readonly target?: string;
  /** Pinned clock for `?mockNow=`. */
  readonly mockNow?: number | string;
  readonly mockNowMode?: 'frozen' | 'advance';
  /** Sets `?nomotion`. */
  readonly noMotion?: boolean;
  /** Installs `window.__clock`. On by default; pass false to test the gate. */
  readonly testApi?: boolean;
}

/** Builds an app URL from options, omitting every parameter not asked for. */
export function appUrl(options: AppOptions = {}): string {
  const params = new URLSearchParams();
  if (options.scene !== undefined) params.set('scene', options.scene);
  if (options.target !== undefined) params.set('target', options.target);
  if (options.mockNow !== undefined) params.set('mockNow', String(options.mockNow));
  if (options.mockNowMode !== undefined) params.set('mockNowMode', options.mockNowMode);
  if (options.noMotion) params.set('nomotion', '1');
  if (options.testApi !== false) params.set('testApi', '1');

  const query = params.toString();
  return query === '' ? '/' : `/?${query}`;
}

/**
 * Options that make a frame reproducible: a frozen clock, an absolute target,
 * and no drift, rotation or easing.
 */
export function deterministicOptions(overrides: AppOptions = {}): AppOptions {
  return {
    mockNow: PINNED_NOW,
    mockNowMode: 'frozen',
    target: PINNED_TARGET,
    noMotion: true,
    ...overrides,
  };
}

/**
 * Navigates to the app and waits until it has actually drawn.
 *
 * Waiting on `drawCalls > 0` rather than on load is the point: it is the single
 * assertion that catches a headless browser that came up without a working GL
 * context, which would otherwise surface as a mysteriously blank screenshot.
 */
export async function gotoApp(page: Page, options: AppOptions = {}): Promise<void> {
  await page.goto(appUrl(options));
  await page.waitForFunction(() => window.__clock !== undefined);
  await expect
    .poll(async () => (await readRendererState(page)).drawCalls, {
      message: 'renderer never issued a draw call — is WebGL2/SwiftShader working?',
    })
    .toBeGreaterThan(0);
}

/** Reads live renderer diagnostics from the test API. */
export async function readRendererState(page: Page): Promise<RendererState> {
  return page.evaluate(() => {
    const api = window.__clock;
    if (!api) throw new Error('window.__clock is not installed — is ?testApi set?');
    return api.renderer();
  });
}

/** The digits currently on the rings. */
export async function readDigits(page: Page): Promise<readonly number[]> {
  return page.evaluate(() => {
    const api = window.__clock;
    if (!api) throw new Error('window.__clock is not installed — is ?testApi set?');
    return api.digits();
  });
}

/** The scene id the app believes is active. */
export async function readSceneId(page: Page): Promise<string> {
  return page.evaluate(() => {
    const api = window.__clock;
    if (!api) throw new Error('window.__clock is not installed — is ?testApi set?');
    return api.sceneId();
  });
}

/** Waits until `count` further frames have been drawn since now. */
export async function waitForFrames(page: Page, count: number): Promise<void> {
  const start = (await readRendererState(page)).frames;
  await expect
    .poll(async () => (await readRendererState(page)).frames, {
      message: `renderer stopped advancing after ${start} frames`,
      timeout: 15_000,
    })
    .toBeGreaterThanOrEqual(start + count);
}

export interface ConsoleWatcher {
  /** `console.error` output plus uncaught page exceptions. */
  readonly errors: string[];
  /** Every console message, for assertions about specific warnings. */
  readonly messages: string[];
  /** URLs that returned 4xx/5xx, recorded so a failure names the asset. */
  readonly failedRequests: string[];
}

/**
 * Records console errors and uncaught exceptions from the moment it is called.
 *
 * Must be installed before `goto`, or start-up failures are missed entirely.
 *
 * Failed responses are tracked separately because Chromium's console message
 * for a bad response is just "Failed to load resource: 404" with no URL, which
 * is close to useless when a test fails in CI.
 */
export function watchConsole(page: Page): ConsoleWatcher {
  const errors: string[] = [];
  const messages: string[] = [];
  const failedRequests: string[] = [];

  page.on('console', (message: ConsoleMessage) => {
    const text = `${message.type()}: ${message.text()}`;
    messages.push(text);
    if (message.type() === 'error') errors.push(text);
  });
  page.on('pageerror', (error: Error) => {
    errors.push(`pageerror: ${error.message}`);
  });
  page.on('response', (response) => {
    if (response.status() >= 400) {
      failedRequests.push(`${response.status()} ${response.url()}`);
    }
  });
  page.on('requestfailed', (request) => {
    failedRequests.push(`failed ${request.url()}: ${request.failure()?.errorText ?? 'unknown'}`);
  });

  return { errors, messages, failedRequests };
}
