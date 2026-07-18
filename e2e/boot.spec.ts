import { expect, test } from '@playwright/test';
import { appUrl, gotoApp, readRendererState, waitForFrames, watchConsole } from './support/app.js';

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

    await page.goto('/');

    const canvas = page.locator('#scene-canvas');
    await expect(canvas).toBeVisible();

    const box = await canvas.boundingBox();
    expect(box?.width ?? 0).toBeGreaterThan(0);
    expect(box?.height ?? 0).toBeGreaterThan(0);

    // The HUD proves main.ts got all the way through bootstrap().
    await expect(page.locator('.hud__countdown')).not.toBeEmpty();

    // Every asset the page asks for must exist — including the favicon the
    // browser requests on its own. A tolerated 404 hides the next real one.
    expect(console_.failedRequests).toEqual([]);
    expect(console_.errors).toEqual([]);
  });

  test('acquires a real WebGL2 context', async ({ page }) => {
    const console_ = watchConsole(page);

    await page.goto('/');

    // three.js has already created the context; `getContext` hands back the
    // same one rather than making a second.
    const gl = await page.evaluate(() => {
      const canvas = document.querySelector<HTMLCanvasElement>('#scene-canvas');
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
    });

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
});

test.describe('test-hook gating', () => {
  test('installs no test API without ?testApi', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('.hud__countdown')).not.toBeEmpty();

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
