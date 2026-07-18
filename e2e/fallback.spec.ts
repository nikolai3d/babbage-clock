import { expect, test } from '@playwright/test';
import {
  PINNED_NOW,
  SELECTOR,
  TICKING_TARGET,
  appUrl,
  deterministicOptions,
  disableWebGL,
  gotoApp,
  readDigits,
  readRendererState,
  waitForFrames,
} from './support/app.js';
import type { Page } from '@playwright/test';

/**
 * Life without a GPU.
 *
 * The site's promise is an accurate countdown; the mechanism is how it is
 * presented. These specs force the two real ways the presentation can fail and
 * insist the promise survives both — never a frozen canvas showing a stale time.
 */

test.describe('no WebGL', () => {
  test('shows a live text countdown when the context cannot be created', async ({ page }) => {
    // The genuine failure: `getContext('webgl2')` returns null. The WebGL2
    // probe in main.ts is meant to skip the render layer's dynamic import
    // entirely on this path, so a GPU-less client never downloads three.js —
    // record every script request and hold it to that below.
    await disableWebGL(page);
    const scripts: string[] = [];
    page.on('request', (request) => {
      if (request.resourceType() === 'script') scripts.push(request.url());
    });

    await page.goto(
      appUrl({
        mockNow: PINNED_NOW,
        mockNowMode: 'advance',
        target: TICKING_TARGET,
      }),
    );
    await expect(page.locator(SELECTOR.loadingScreen)).toHaveCount(0, { timeout: 20_000 });

    const fallback = page.locator(SELECTOR.fallbackView);
    await expect(fallback).toBeVisible();

    // The payload promise, not just the visual one: no renderer chunk and no
    // three.js chunk were ever requested. (In dev Vite serves modules
    // individually, so match the source paths as well as the built names.)
    const rendering = scripts.filter((url) => /three|renderer-|\/render\//.test(url));
    expect(
      rendering,
      `render-layer scripts fetched without WebGL: ${rendering.join(', ')}`,
    ).toHaveLength(0);
    await expect(page.locator(SELECTOR.fallbackNote)).toContainText('WebGL');

    // The canvas is out of the document's flow and out of the tab order, so it
    // cannot sit in front of the countdown as an unlabelled focus stop.
    await expect(page.locator(SELECTOR.canvas)).toBeHidden();
    // And the HUD readout is hidden, so the countdown is not announced or
    // rendered twice.
    await expect(page.locator(SELECTOR.readout)).toBeHidden();

    // The countdown is not a still image of one: it advances on the same clock.
    const first = await page.locator(SELECTOR.fallbackCountdown).textContent();
    expect(first).toMatch(/\d/);
    await expect
      .poll(async () => page.locator(SELECTOR.fallbackCountdown).textContent(), {
        message: 'the fallback countdown never advanced',
        timeout: 10_000,
      })
      .not.toBe(first);

    // The text mirror still works, because it reads the store, not the canvas.
    await expect(page.locator(SELECTOR.announcement)).toContainText('remaining.');
  });

  test('the settings drawer still works with no renderer', async ({ page }) => {
    await disableWebGL(page);
    await page.goto(appUrl(deterministicOptions()));
    await expect(page.locator(SELECTOR.loadingScreen)).toHaveCount(0, { timeout: 20_000 });

    await page.locator(SELECTOR.settingsToggle).click();
    await expect(page.locator(SELECTOR.settingsPanel)).toBeVisible();

    // Changing the scene is a no-op for the picture, but it must not throw and
    // take the countdown down with it.
    await page.locator(SELECTOR.sceneSelect).selectOption('slate-orrery');
    await expect(page.locator(SELECTOR.fallbackCountdown)).not.toBeEmpty();
  });
});

declare global {
  interface Window {
    /**
     * The `WEBGL_lose_context` handle, kept from before the loss.
     *
     * It has to be stashed: once the context is lost, `getExtension` on it
     * returns null, so a second lookup could never find `restoreContext`.
     */
    __loseContext?: WEBGL_lose_context;
  }
}

/**
 * Takes the context away exactly as the browser would.
 *
 * `WEBGL_lose_context` fires the real `webglcontextlost` event on the real
 * canvas — this is the browser's own simulation of the iOS failure, not a stub
 * of our handler.
 */
async function loseContext(page: Page): Promise<void> {
  await page.evaluate((selector) => {
    const canvas = document.querySelector<HTMLCanvasElement>(selector);
    // The same context three.js is using: `getContext` returns the existing one.
    const gl = canvas?.getContext('webgl2');
    const extension = gl?.getExtension('WEBGL_lose_context');
    if (!extension) throw new Error('WEBGL_lose_context is unavailable — cannot simulate the loss');
    window.__loseContext = extension;
    extension.loseContext();
  }, SELECTOR.canvas);
}

async function restoreContext(page: Page): Promise<void> {
  await page.evaluate(() => {
    const extension = window.__loseContext;
    if (!extension) throw new Error('loseContext() must run first');
    extension.restoreContext();
  });
}

test.describe('context loss', () => {
  test('falls back to text and recovers to the right time', async ({ page }) => {
    await gotoApp(page, deterministicOptions());
    const digitsBefore = await readDigits(page);
    const sceneBefore = await readRendererState(page);

    await loseContext(page);

    // The loop stops rather than spinning on a dead context, and the text view
    // takes over — a canvas left on its last frame would show a stale time.
    await expect
      .poll(async () => (await readRendererState(page)).contextLost, {
        message: 'the renderer never noticed the context loss',
      })
      .toBe(true);
    expect((await readRendererState(page)).running).toBe(false);
    await expect(page.locator(SELECTOR.fallbackView)).toBeVisible();
    await expect(page.locator(SELECTOR.fallbackNote)).toContainText('graphics context was lost');
    await expect(page.locator(SELECTOR.fallbackCountdown)).not.toBeEmpty();

    await restoreContext(page);

    await expect
      .poll(async () => (await readRendererState(page)).contextLost, {
        message: 'the context was restored but the renderer did not notice',
        timeout: 15_000,
      })
      .toBe(false);

    // Back to the mechanism: the fallback goes away, the readout comes back,
    // and the scene is the one that was showing — with the right digits on it.
    await expect(page.locator(SELECTOR.fallbackView)).toBeHidden();
    await expect(page.locator(SELECTOR.readout)).toBeVisible();
    await waitForFrames(page, 5);

    const after = await readRendererState(page);
    expect(after.running).toBe(true);
    expect(after.drawCalls, 'nothing reached the GPU after the restore').toBeGreaterThan(0);
    expect(after.sceneId).toBe(sceneBefore.sceneId);
    expect(await readDigits(page)).toEqual(digitsBefore);
  });

  test('keeps the countdown advancing while the context is gone', async ({ page }) => {
    await gotoApp(page, {
      mockNow: PINNED_NOW,
      mockNowMode: 'advance',
      target: TICKING_TARGET,
      noMotion: true,
    });

    await loseContext(page);
    await expect(page.locator(SELECTOR.fallbackView)).toBeVisible();

    const first = await page.locator(SELECTOR.fallbackCountdown).textContent();
    await expect
      .poll(async () => page.locator(SELECTOR.fallbackCountdown).textContent(), {
        message: 'the countdown froze along with the canvas',
        timeout: 10_000,
      })
      .not.toBe(first);
  });
});

test.describe('large text mode', () => {
  test('is a choice, not a failure: toggles the text view and parks the loop', async ({ page }) => {
    await gotoApp(page, { mockNow: PINNED_NOW, mockNowMode: 'advance', target: TICKING_TARGET });

    await page.locator('#settings-toggle').click();
    await page.locator('#large-text-toggle').check();
    await page.keyboard.press('Escape');

    const fallback = page.locator(SELECTOR.fallbackView);
    await expect(fallback).toBeVisible();
    // The note reads as a choice, not a warning.
    await expect(fallback).toContainText('Large text mode');
    // The loop is parked — this is the battery half of the feature.
    await expect.poll(async () => (await readRendererState(page)).running).toBe(false);
    // The countdown still advances in text.
    const before = await fallback.locator('.fallback__countdown').textContent();
    await expect
      .poll(async () => fallback.locator('.fallback__countdown').textContent())
      .not.toBe(before);

    // And back: mechanism returns, loop resumes.
    await page.locator('#settings-toggle').click();
    await page.locator('#large-text-toggle').uncheck();
    await expect(fallback).toBeHidden();
    await expect.poll(async () => (await readRendererState(page)).running).toBe(true);
  });

  test('survives a reload', async ({ page }) => {
    await gotoApp(page, { mockNow: PINNED_NOW, mockNowMode: 'advance', target: TICKING_TARGET });
    await page.locator('#settings-toggle').click();
    await page.locator('#large-text-toggle').check();

    await page.reload();
    await page.waitForFunction(() => window.__clock !== undefined);
    await expect(page.locator(SELECTOR.fallbackView)).toBeVisible();
    await expect.poll(async () => (await readRendererState(page)).running).toBe(false);
  });
});
