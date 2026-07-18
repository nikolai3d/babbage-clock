import { expect, test } from '@playwright/test';
import {
  appUrl,
  blockExternalRequests,
  SELECTOR,
  gotoApp,
  readRendererState,
  waitForFrames,
  watchConsole,
} from './support/app.js';

/**
 * Start-up and the WebGL2 contract.
 *
 * The WebGL assertions here are the suite's canary: if headless Chromium comes
 * up without a working software GL stack, every screenshot would silently
 * become a picture of a blank canvas. These tests fail loudly instead.
 */

test.describe('boot', () => {
  test('renders a sized canvas with no console errors', async ({ page }) => {
    const console_ = watchConsole(page);

    // `?nosync` only: no test API, no pinned clock, no motion changes — as
    // close to a plain production load as a hermetic run allows. The real
    // sync path has its own test below.
    await page.goto(appUrl({ testApi: false }));

    const canvas = page.locator(SELECTOR.canvas);
    await expect(canvas).toBeVisible();

    const box = await canvas.boundingBox();
    expect(box?.width ?? 0).toBeGreaterThan(0);
    expect(box?.height ?? 0).toBeGreaterThan(0);

    // The HUD proves main.ts got all the way through bootstrap().
    await expect(page.locator(SELECTOR.countdown)).not.toBeEmpty();

    // Every asset the page asks for must exist — including the favicon the
    // browser requests on its own. A tolerated 404 hides the next real one.
    expect(console_.failedRequests).toEqual([]);
    expect(console_.errors).toEqual([]);
  });

  test('acquires a real WebGL2 context', async ({ page }) => {
    const console_ = watchConsole(page);

    await page.goto(appUrl({ testApi: false }));

    // three.js has already created the context; `getContext` hands back the
    // same one rather than making a second.
    // The selector is passed in: this callback is serialised and runs in the
    // browser, where the module-scope `SELECTOR` does not exist.
    const gl = await page.evaluate((canvasSelector) => {
      const canvas = document.querySelector<HTMLCanvasElement>(canvasSelector);
      const context = canvas?.getContext('webgl2');
      if (!context) return null;

      const debug = context.getExtension('WEBGL_debug_renderer_info');
      return {
        version: context.getParameter(context.VERSION) as string,
        renderer: debug
          ? (context.getParameter(debug.UNMASKED_RENDERER_WEBGL) as string)
          : (context.getParameter(context.RENDERER) as string),
        maxTextureSize: context.getParameter(context.MAX_TEXTURE_SIZE) as number,
      };
    }, SELECTOR.canvas);

    expect(gl, 'no WebGL2 context — check the SwiftShader launch flags').not.toBeNull();
    expect(gl?.version).toContain('WebGL 2.0');
    expect(gl?.maxTextureSize ?? 0).toBeGreaterThan(0);
    // Recorded so a CI log shows which backend actually served the run.
    console.info(`[e2e] WebGL2 renderer: ${gl?.renderer ?? 'unknown'}`);

    // The app warns on a WebGL1 fallback. Its absence is the real assertion.
    expect(console_.messages.filter((line) => line.includes('WebGL2 unavailable'))).toEqual([]);
  });

  test('draws frames continuously', async ({ page }) => {
    await gotoApp(page);

    const initial = await readRendererState(page);
    expect(initial.webgl2, 'renderer fell back off WebGL2').toBe(true);
    expect(initial.running).toBe(true);
    expect(
      initial.drawCalls,
      'scene presented nothing — geometry never reached the GPU',
    ).toBeGreaterThan(0);
    expect(initial.triangles).toBeGreaterThan(0);
    expect(initial.width).toBeGreaterThan(0);
    expect(initial.height).toBeGreaterThan(0);

    await waitForFrames(page, 5);
  });

  /**
   * The app corrects its clock against a chain of time services on boot. That
   * network call must never be load-bearing: an offline viewer, a blocked
   * request or a dead provider has to degrade to the device clock silently.
   *
   * This is the only spec that leaves the sync enabled — the rest set
   * `?nosync` to stay hermetic — so it is also the only one that needs request
   * interception.
   */
  test('degrades quietly when the time-sync services are unreachable', async ({ page }) => {
    const console_ = watchConsole(page);
    const blocked = await blockExternalRequests(page);

    // The one test that lets the real sync run, with every external provider
    // refused. The rest of the suite sets `?nosync` for hermeticity.
    await page.goto(appUrl({ noSync: false }));
    await page.waitForFunction(() => window.__clock !== undefined);
    await waitForFrames(page, 5);

    // It did reach out, and was refused.
    await expect
      .poll(() => blocked.length, { message: 'the app never attempted a time sync' })
      .toBeGreaterThan(0);

    // And carried on: no exceptions, a live clock, a rendering scene.
    expect(console_.errors).toEqual([]);
    expect(await page.evaluate(() => window.__clock?.now() ?? 0)).toBeGreaterThan(0);
    expect((await readRendererState(page)).drawCalls).toBeGreaterThan(0);
  });
});

test.describe('test-hook gating', () => {
  test('installs no test API without ?testApi', async ({ page }) => {
    await page.goto(appUrl({ testApi: false }));
    await expect(page.locator(SELECTOR.countdown)).not.toBeEmpty();

    expect(await page.evaluate(() => window.__clock === undefined)).toBe(true);
  });

  test('leaves motion on and the clock live without hook parameters', async ({ page }) => {
    // `?testApi` alone must not imply any of the other hooks.
    await gotoApp(page);

    const state = await readRendererState(page);
    expect(state.motion).toBe(true);

    const hooks = await page.evaluate(() => window.__clock?.hooks());
    expect(hooks?.mockNowMs).toBeNull();
    expect(hooks?.motion).toBe(true);

    // A live clock tracks real time, so the app's `now()` is close to ours.
    const drift = Math.abs((await page.evaluate(() => window.__clock?.now() ?? 0)) - Date.now());
    expect(drift).toBeLessThan(60_000);
  });

  test('?nomotion is inert unless requested', async ({ page }) => {
    await page.goto(appUrl({ noMotion: true }));
    await page.waitForFunction(() => window.__clock !== undefined);
    expect((await readRendererState(page)).motion).toBe(false);

    await page.goto(appUrl({}));
    await page.waitForFunction(() => window.__clock !== undefined);
    expect((await readRendererState(page)).motion).toBe(true);
  });
});
