import { expect, test } from '@playwright/test';
import {
  SELECTOR,
  TICKING_TARGET,
  deterministicOptions,
  gotoApp,
  openSettings,
  readDigits,
  readRendererState,
  waitForFrames,
} from './support/app.js';
import { sceneRegistry } from '../src/scene/scenes/index.js';
import type { Page } from '@playwright/test';

/**
 * The portrait-phone project.
 *
 * Runs only in `mobile-portrait` (see `playwright.config.ts`), and covers only
 * what a phone viewport changes: how the camera is framed, how the 2D shell
 * reflows, and whether touch input reaches the canvas. Everything that is not
 * viewport-dependent — boot, WebGL2, digit packing, time — is already covered
 * once by the desktop project, and running it twice would buy nothing for a
 * meaningful share of the CI budget.
 *
 * What this cannot cover, and what no CI job can: a real phone. Chromium's
 * device emulation gives the viewport, the touch event model and the pointer
 * media queries, but its GPU is SwiftShader on a Linux runner. Thermal
 * behaviour, iOS memory limits and Safari's own quirks are unverified here; the
 * manual checklist for them is in `docs/testing.md`.
 */

/** Fraction of the viewport width the drums must span to count as legible. */
const MIN_RING_WIDTH_FRACTION = 0.5;

function viewportSize(page: Page): { width: number; height: number } {
  const size = page.viewportSize();
  if (!size) throw new Error('the mobile project must define a viewport');
  return size;
}

test.describe('portrait phone', () => {
  test('shows the whole readout without any interaction', async ({ page }) => {
    await gotoApp(page, deterministicOptions());
    const { width } = viewportSize(page);
    const state = await readRendererState(page);

    // The acceptance criterion, as two numbers. Not cropped: the drums fit
    // inside the viewport. Legible: they fill at least half of it, which on a
    // seven-ring scene puts each numeral around 8 mm on a real handset.
    expect(state.ringExtentPx).toBeLessThanOrEqual(width);
    expect(state.ringExtentPx).toBeGreaterThan(width * MIN_RING_WIDTH_FRACTION);
    // A portrait viewport is too narrow to hold the case as well, so the
    // framing is expected to have chosen the rings over the scenery.
    expect(state.framingFit).toBe('rings');

    // And the mechanism really is drawing all of it.
    expect(state.drawCalls).toBeGreaterThan(0);
    expect(await readDigits(page)).toHaveLength(sceneRegistry.list()[0]!.rings.count);

    // The DOM readout is on screen too, and nothing is over it.
    const readout = page.locator(SELECTOR.readout);
    await expect(readout).toBeVisible();
    const box = await readout.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.y + box!.height).toBeLessThanOrEqual(viewportSize(page).height);
  });

  test('picks the low quality tier automatically and lets the viewer override it', async ({
    page,
  }) => {
    // The one spec that must *not* pin the tier — the heuristic is the subject.
    await gotoApp(page, deterministicOptions({ quality: 'auto' }));

    // A touch device with a phone-sized viewport: the heuristic's primary rule.
    expect((await readRendererState(page)).quality).toBe('low');
    expect((await readRendererState(page)).maxFps).toBe(30);

    // The override has to work, or a viewer on a capable phone is stuck with a
    // decision the app made for them.
    await openSettings(page);
    await page.locator(SELECTOR.qualitySelect).selectOption('high');
    await expect.poll(async () => (await readRendererState(page)).quality).toBe('high');
    expect((await readRendererState(page)).maxFps).toBeNull();
  });

  test('keeps ticking', async ({ page }) => {
    await gotoApp(
      page,
      deterministicOptions({ target: TICKING_TARGET, mockNowMode: 'advance', noMotion: false }),
    );

    const before = await page.locator(SELECTOR.countdown).textContent();
    // A small count: frames are expensive under software rendering, and this is
    // a liveness check, not a benchmark.
    await waitForFrames(page, 3);
    await expect.poll(async () => page.locator(SELECTOR.countdown).textContent()).not.toBe(before);
  });

  test('opens the drawer as a bottom sheet that does not cover the readout', async ({ page }) => {
    await gotoApp(page, deterministicOptions());
    const { width, height } = viewportSize(page);

    // Tapped, not clicked: this is the gesture a phone actually sends, and it
    // is the one that would break if the toggle were under something.
    await page.locator(SELECTOR.settingsToggle).tap();
    await expect(page.locator(SELECTOR.settingsPanel)).toBeVisible();

    const panel = (await page.locator(SELECTOR.settingsPanel).boundingBox())!;
    const readout = (await page.locator(SELECTOR.readout).boundingBox())!;

    // A sheet: full width, in the lower half, reaching the bottom edge.
    //
    // Not an exact equality on the bottom edge, for two reasons that are both
    // artefacts rather than layout: the sheet animates in with a 1.5rem rise,
    // and Chromium's mobile emulation sizes the initial containing block a few
    // pixels taller than `window.innerHeight`. Either can put the measured edge
    // a little past the viewport without anything being wrong.
    expect(panel.width).toBeCloseTo(width, 0);
    expect(panel.y).toBeGreaterThan(0);
    expect(panel.y + panel.height).toBeGreaterThanOrEqual(height - 2);

    // The regression this whole reflow exists for — the readout used to sit
    // underneath the open drawer, which is the one thing the page is for.
    expect(readout.y + readout.height).toBeLessThanOrEqual(panel.y);

    // Touch targets are finger-sized.
    const toggle = (await page.locator(SELECTOR.settingsToggle).boundingBox())!;
    expect(toggle.height).toBeGreaterThanOrEqual(44);

    // The sheet scrolls inside itself rather than moving the page.
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth),
    ).toBeLessThanOrEqual(0);
  });

  test('orbits with one finger and zooms with two', async ({ page }) => {
    await gotoApp(page, deterministicOptions());
    const { width, height } = viewportSize(page);
    const cx = Math.round(width / 2);
    const cy = Math.round(height / 2);

    // Playwright's `touchscreen` can only tap, so the drag and the pinch go in
    // through CDP — the same input pipeline a real touch takes, rather than
    // synthetic events the browser would treat differently.
    const cdp = await page.context().newCDPSession(page);
    const touch = async (
      type: 'touchStart' | 'touchMove' | 'touchEnd',
      points: { x: number; y: number }[],
    ): Promise<void> => {
      await cdp.send('Input.dispatchTouchEvent', {
        type,
        touchPoints: points.map((point, index) => ({ ...point, id: index })),
      });
    };

    const startPosition = (await readRendererState(page)).cameraPosition;

    // One finger: orbit.
    await touch('touchStart', [{ x: cx, y: cy }]);
    await touch('touchMove', [{ x: cx + 60, y: cy }]);
    await touch('touchMove', [{ x: cx + 120, y: cy }]);
    await touch('touchEnd', []);

    await expect
      .poll(async () => (await readRendererState(page)).cameraPosition[0])
      .not.toBe(startPosition[0]);

    const orbited = (await readRendererState(page)).cameraPosition;
    const distanceOf = (p: readonly [number, number, number]): number => Math.hypot(...p);

    // Two fingers: pinch. Fingers moving apart dollies in, which is a change in
    // distance and not just another rotation.
    await touch('touchStart', [
      { x: cx - 40, y: cy },
      { x: cx + 40, y: cy },
    ]);
    await touch('touchMove', [
      { x: cx - 90, y: cy },
      { x: cx + 90, y: cy },
    ]);
    await touch('touchMove', [
      { x: cx - 140, y: cy },
      { x: cx + 140, y: cy },
    ]);
    await touch('touchEnd', []);

    await expect
      .poll(async () => distanceOf((await readRendererState(page)).cameraPosition))
      .not.toBe(distanceOf(orbited));

    // Whatever the gestures did, they must not have escaped the canvas: the
    // page itself never scrolls or zooms.
    expect(
      await page.evaluate(() => ({
        scrollX: window.scrollX,
        scrollY: window.scrollY,
        overflow: document.documentElement.scrollWidth - window.innerWidth,
      })),
    ).toEqual({ scrollX: 0, scrollY: 0, overflow: 0 });
  });

  test('renders its reference frame', async ({ page }) => {
    test.skip(
      process.platform !== 'linux' && !process.env.PW_SCREENSHOTS,
      'baselines are Linux/SwiftShader only; see docs/testing.md (set PW_SCREENSHOTS=1 to force)',
    );

    await gotoApp(page, deterministicOptions());
    await waitForFrames(page, 5);
    await page.evaluate(() => document.fonts.ready);

    await expect(page).toHaveScreenshot('mobile-portrait.png');
  });
});
