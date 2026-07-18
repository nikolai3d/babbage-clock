import { expect } from '@playwright/test';
import { E2E_BASE_URL } from './env.js';
import type { ConsoleMessage, Page } from '@playwright/test';
import type { RendererState } from '../../src/app/testHooks.js';

/**
 * Helpers for driving the app.
 *
 * Specs assert on `window.__clock` (installed by `?testApi`) rather than on
 * pixels wherever they can: state assertions say *why* something failed, and
 * they do not need a screenshot baseline to be meaningful.
 */

/**
 * Every DOM selector the suite depends on, in one place.
 *
 * The UI is expected to keep changing. Keeping the selectors here means a
 * rename costs one line rather than a hunt through four spec files — and makes
 * it obvious exactly how much of the DOM the tests are coupled to.
 */
export const SELECTOR = {
  canvas: '#scene-canvas',
  countdown: '.readout__countdown',
  loadingScreen: '#loading-screen',
  settingsToggle: '#settings-toggle',
  settingsPanel: '#settings-panel',
  sceneSelect: '#scene-select',
} as const;

/** A time far enough from any real "now" that a stale pin is obvious. */
export const PINNED_NOW = Date.UTC(2026, 5, 15, 12, 0, 0);
/** Roughly 200 days after {@link PINNED_NOW}, so every ring has a digit on it. */
export const PINNED_TARGET = '2027-01-01T00:00:00Z';
/**
 * A target inside the `HHH:MM:SS` display range (~10 hours after
 * {@link PINNED_NOW}).
 *
 * {@link PINNED_TARGET} is ~4,800 hours out, which the rings correctly pin at
 * `999:59:59` — so a spec that needs to watch the digits *move* has to count
 * down from somewhere under the cap. Use this one for anything asserting that
 * the mechanism advances, and `PINNED_TARGET` for everything else.
 */
export const TICKING_TARGET = '2026-06-15T22:30:00Z';

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
  /**
   * Sets `?nosync`, skipping the network clock correction. **On by default**,
   * which is what keeps the suite hermetic and fast; pass `false` to exercise
   * the real sync path.
   */
  readonly noSync?: boolean;
  /** Installs `window.__clock`. On by default; pass false to test the gate. */
  readonly testApi?: boolean;
}

/**
 * Builds an app URL from options, omitting every parameter not asked for.
 *
 * The result is `./`-relative, never root-absolute. Playwright resolves it
 * against `baseURL`, and the deployed site is a GitHub Pages *project* page
 * served from `/babbage-clock/` — a leading `/` would resolve to the domain
 * root and every request in the live smoke run would 404. `./` keeps the base
 * path, and collapses to the root when there is none.
 */
export function appUrl(options: AppOptions = {}): string {
  const params = new URLSearchParams();
  if (options.scene !== undefined) params.set('scene', options.scene);
  if (options.target !== undefined) params.set('target', options.target);
  if (options.mockNow !== undefined) params.set('mockNow', String(options.mockNow));
  if (options.mockNowMode !== undefined) params.set('mockNowMode', options.mockNowMode);
  if (options.noMotion) params.set('nomotion', '1');
  if (options.noSync !== false) params.set('nosync', '1');
  if (options.testApi !== false) params.set('testApi', '1');

  const query = params.toString();
  return query === '' ? './' : `./?${query}`;
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
 * Cuts the page off from every clock-synchronisation source.
 *
 * On boot the app corrects its clock against a provider chain
 * (`src/time/providers.ts`): two external services, then — as a last resort —
 * a `HEAD` against its *own* origin, reading the `Date` response header.
 *
 * Both halves have to go:
 *
 * - The external calls make the suite depend on the public internet, so CI
 *   would go red for reasons unrelated to the change under test.
 * - The same-origin `HEAD` probe is worse in practice. It is issued repeatedly
 *   for sampling, and against a single local preview server with parallel
 *   workers it can exhaust Chromium's per-host connection pool — starving the
 *   page's own module requests, so the app never finishes booting. That
 *   presents as an inexplicable 45-second timeout.
 *
 * `HEAD` is a safe discriminator: the app issues one for nothing else, and the
 * browser never does for ordinary assets. Everything else on the app's origin
 * is passed straight through.
 *
 * **Use this only in specs that deliberately leave the sync enabled.**
 * Everywhere else `?nosync` stops the traffic at source, and route
 * interception is then pure cost: it proxies every request — including the
 * ~600 kB module bundle — through the driver process, which under parallel
 * workers is enough to make a page load time out.
 *
 * Returns the array of blocked URLs, which fills in as the page runs.
 */
export async function blockExternalRequests(page: Page): Promise<string[]> {
  const blocked: string[] = [];
  const origin = new URL(E2E_BASE_URL).origin;

  await page.route('**/*', async (route) => {
    const request = route.request();
    const url = request.url();

    const isOwnOrigin =
      url.startsWith(origin) || url.startsWith('data:') || url.startsWith('blob:');
    const isTimeProbe = request.method() === 'HEAD';

    if (isOwnOrigin && !isTimeProbe) {
      await route.continue();
      return;
    }

    blocked.push(`${request.method()} ${url}`);
    await route.abort();
  });

  return blocked;
}

/**
 * Navigates to the app and waits until it has actually drawn.
 *
 * Waiting on `drawCalls > 0` rather than on load is the point: it is the single
 * assertion that catches a headless browser that came up without a working GL
 * context, which would otherwise surface as a mysteriously blank screenshot.
 */
export async function gotoApp(page: Page, options: AppOptions = {}): Promise<void> {
  // No request interception here on purpose: `appUrl` sets `?nosync`, so the
  // page requests nothing but its own assets, and routing them through the
  // driver would only add latency.
  await page.goto(appUrl(options));
  await page.waitForFunction(() => window.__clock !== undefined);
  // The loading screen covers the canvas until boot completes; anything that
  // clicks, or photographs, the UI has to wait it out.
  await waitForLoadingScreen(page);
  await expect
    .poll(async () => (await readRendererState(page)).drawCalls, {
      message: 'renderer never issued a draw call — is WebGL2/SwiftShader working?',
    })
    .toBeGreaterThan(0);
  await waitForLighting(page);
}

/**
 * Waits for the lighting mood to settle.
 *
 * Deliberately *not* folded into the loading screen: a mood's HDR environment
 * map is fetched lazily so it never delays first paint, which means the app is
 * fully booted and drawing while the map is still on its way. Frames captured
 * in that window show the previous mood, so a screenshot has to wait here or it
 * photographs a race.
 */
export async function waitForLighting(page: Page): Promise<void> {
  await expect
    .poll(async () => (await readRendererState(page)).lighting, {
      message: 'lighting mood never finished loading — see docs/lighting.md',
      timeout: 20_000,
    })
    .not.toBe('loading');
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

/**
 * Waits for the loading screen to go away.
 *
 * It is authored directly in `index.html` so it paints before any JavaScript
 * runs, and `ui/loadingScreen.ts` removes it once boot finishes. Screenshots
 * taken before then are pictures of the loader.
 */
export async function waitForLoadingScreen(page: Page): Promise<void> {
  await expect(page.locator(SELECTOR.loadingScreen)).toHaveCount(0, { timeout: 20_000 });
}

/**
 * Opens the settings drawer, where the scene picker lives.
 *
 * The panel is collapsed by default — the clock is the hero — and its contents
 * are `hidden` until then, so its controls cannot be driven without this.
 */
export async function openSettings(page: Page): Promise<void> {
  const panel = page.locator(SELECTOR.settingsPanel);
  if (await panel.isVisible()) return;

  await page.locator(SELECTOR.settingsToggle).click();
  await expect(panel).toBeVisible();
}

/** Waits until `count` further frames have been drawn since now. */
/**
 * The budget is a liveness bound, not a performance assertion.
 *
 * Image-based lighting costs about 3x per frame under SwiftShader — measured at
 * ~22 fps with `?mood=none` against ~7 fps with an environment map, because
 * every PBR fragment gains a prefiltered cube lookup and a CPU rasteriser pays
 * for it in full. Three parallel workers on a two-core runner then share that
 * between them, which is enough to push 30 frames past 15 seconds.
 *
 * Raising the ceiling rather than lowering the frame count keeps every caller's
 * assertion exactly as strong: the renderer must still advance the frames it
 * was asked for, and a genuinely stalled loop still fails.
 */
export async function waitForFrames(page: Page, count: number): Promise<void> {
  const start = (await readRendererState(page)).frames;
  await expect
    .poll(async () => (await readRendererState(page)).frames, {
      message: `renderer stopped advancing after ${start} frames`,
      timeout: 45_000,
    })
    .toBeGreaterThanOrEqual(start + count);
}

export interface ConsoleWatcher {
  /**
   * Application-level errors: `console.error` from our own code plus uncaught
   * exceptions. Browser resource-load messages are excluded — see
   * {@link failedRequests}.
   */
  readonly errors: string[];
  /** Every console message, for assertions about specific warnings. */
  readonly messages: string[];
  /**
   * Own-origin requests that failed or returned 4xx/5xx, with their URLs.
   *
   * This is the precise version of "did every asset load": Chromium's console
   * text for a failed request is just "Failed to load resource: 404" with no
   * URL, which is close to useless when a test fails in CI.
   */
  readonly failedRequests: string[];
}

/** Chromium's console text for any failed subresource load. */
const RESOURCE_ERROR = /^Failed to load resource/;

/**
 * Records console errors and uncaught exceptions from the moment it is called.
 *
 * Must be installed before `goto`, or start-up failures are missed entirely.
 *
 * The two error channels are deliberately split:
 *
 * - `errors` answers "did the application misbehave" — exceptions and our own
 *   `console.error` calls.
 * - `failedRequests` answers "did every asset load", scoped to the app's own
 *   origin.
 *
 * Resource-load messages are kept out of `errors` because
 * {@link blockExternalRequests} aborts the cross-origin time-sync calls on
 * purpose, and Chromium logs an un-attributable `net::ERR_FAILED` for each.
 * Folding those into `errors` would force the assertion to be loosened to the
 * point of catching nothing. Nothing is lost: a genuine own-origin failure
 * still fails via `failedRequests`, with the URL attached.
 */
export function watchConsole(page: Page): ConsoleWatcher {
  const errors: string[] = [];
  const messages: string[] = [];
  const failedRequests: string[] = [];

  page.on('console', (message: ConsoleMessage) => {
    const text = `${message.type()}: ${message.text()}`;
    messages.push(text);
    if (message.type() === 'error' && !RESOURCE_ERROR.test(message.text())) {
      errors.push(text);
    }
  });
  page.on('pageerror', (error: Error) => {
    errors.push(`pageerror: ${error.message}`);
  });
  // Scoped to the app's own origin: cross-origin time-sync calls are aborted
  // on purpose by `blockExternalRequests`, and counting those as failures
  // would make the assertion meaningless.
  const origin = new URL(E2E_BASE_URL).origin;
  const isOwnOrigin = (url: string): boolean => url.startsWith(origin);

  page.on('response', (response) => {
    if (response.status() >= 400 && isOwnOrigin(response.url())) {
      failedRequests.push(`${response.status()} ${response.url()}`);
    }
  });
  page.on('requestfailed', (request) => {
    if (!isOwnOrigin(request.url())) return;

    const reason = request.failure()?.errorText ?? 'unknown';
    // `ERR_ABORTED` means the client withdrew the request, not that the server
    // failed to serve it. The time module's `http-date` provider probes the
    // app's own origin and cancels it once a better source answers, and any
    // navigation aborts requests still in flight. Neither is a broken asset.
    if (reason.includes('ERR_ABORTED')) return;

    failedRequests.push(`failed ${request.url()}: ${reason}`);
  });

  return { errors, messages, failedRequests };
}
