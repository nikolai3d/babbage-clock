import { expect, test } from '@playwright/test';
import {
  SELECTOR,
  appUrl,
  openSettings,
  waitForFrames,
  waitForLoadingScreen,
} from '../e2e/support/app.js';
import { sceneRegistry } from '../src/scene/scenes/index.js';

/**
 * Scripted demo tour, saved as video to `artifacts/`.
 *
 * Run on demand with `npm run capture:demo`; it is not part of CI.
 *
 * The clock is pinned with `mockNowMode=advance` rather than frozen: the tour
 * starts from a known, nicely-shaped countdown but then ticks in real time, so
 * the recording shows genuine ring animation instead of a still image. Motion
 * stays on — this is the one place the flourishes are the point.
 */

/** Relative to the repo root; `saveAs` creates the directory if it is missing. */
const DEMO_VIDEO = 'artifacts/babbage-clock-demo.webm';

/** Start ~12 days out, so the day, hour, minute and second rings all read. */
const DEMO_TARGET = '2027-01-01T00:00:00Z';
const DEMO_START =
  Date.parse(DEMO_TARGET) - (12 * 86_400_000 + 3 * 3_600_000 + 14 * 60_000 + 7_000);

/** Long enough for several visible ticks without padding the recording. */
const TICK_WATCH_MS = 6_000;

test('demo tour', async ({ page }) => {
  const scenes = sceneRegistry.list();
  const first = scenes[0]!;
  const second = scenes[1] ?? first;

  // 1. Boot.
  await page.goto(
    appUrl({
      scene: first.id,
      target: DEMO_TARGET,
      mockNow: DEMO_START,
      mockNowMode: 'advance',
      // The capture is a marketing artefact: present the healthy synced
      // status a production viewer sees, not the hermetic run's warning.
      mockSync: true,
    }),
  );
  await page.waitForFunction(() => window.__clock !== undefined);
  await waitForLoadingScreen(page);
  await waitForFrames(page, 10);
  await expect(page.locator(SELECTOR.countdown)).not.toBeEmpty();

  // 2. Several live ticks.
  await page.waitForTimeout(TICK_WATCH_MS);

  // 3. An orbit: drag across the canvas and back, so the mechanism is seen
  //    from more than one angle.
  const canvas = page.locator(SELECTOR.canvas);
  const box = await canvas.boundingBox();
  if (!box) throw new Error('canvas has no layout box');

  const centreX = box.x + box.width / 2;
  const centreY = box.y + box.height / 2;

  await page.mouse.move(centreX, centreY);
  await page.mouse.down();
  for (let step = 1; step <= 40; step += 1) {
    const angle = (step / 40) * Math.PI * 2;
    await page.mouse.move(centreX + Math.sin(angle) * 240, centreY - Math.cos(angle) * 60);
    await page.waitForTimeout(25);
  }
  await page.mouse.up();
  await page.waitForTimeout(1_000);

  // 4. A scene switch.
  await openSettings(page);
  await page.locator(SELECTOR.sceneSelect).selectOption(second.id);
  await expect.poll(async () => page.evaluate(() => window.__clock?.sceneId())).toBe(second.id);
  await page.waitForTimeout(TICK_WATCH_MS);

  // The video is only finalised once the page closes, so save after closing.
  const video = page.video();
  await page.close();
  if (video) {
    await video.saveAs(DEMO_VIDEO);
    console.info(`[capture] demo video written to ${DEMO_VIDEO}`);
  }
});
