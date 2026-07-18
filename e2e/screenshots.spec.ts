import { expect, test } from '@playwright/test';
import {
  PINNED_TARGET,
  deterministicOptions,
  gotoApp,
  readDigits,
  waitForFrames,
} from './support/app.js';
import { sceneRegistry } from '../src/scene/scenes/index.js';
import type { Page } from '@playwright/test';

/**
 * Visual baselines.
 *
 * Baselines are Linux/SwiftShader images produced inside the Playwright
 * container, which is also what CI runs in — see `docs/testing.md` for the
 * one-command regeneration recipe. They are skipped elsewhere so that macOS
 * developers do not generate a second, conflicting set on every run.
 *
 * Every shot is taken in fully deterministic mode: a frozen clock, an absolute
 * target, no drift/rotation/easing, a fixed viewport, UTC and en-US.
 */

test.describe('screenshots', () => {
  test.skip(
    process.platform !== 'linux' && !process.env.PW_SCREENSHOTS,
    'baselines are Linux/SwiftShader only; see docs/testing.md (set PW_SCREENSHOTS=1 to force)',
  );

  const scenes = sceneRegistry.list();

  /** Waits until the pinned frame has settled, then removes font flicker. */
  async function settle(page: Page): Promise<void> {
    // `gotoApp` already waits out the loading screen; this covers the frames
    // and font loading that follow it.
    await waitForFrames(page, 5);
    await page.evaluate(() => document.fonts.ready);
  }

  for (const scene of scenes.slice(0, 2)) {
    test(`${scene.id} renders its reference frame`, async ({ page }) => {
      await gotoApp(page, deterministicOptions({ scene: scene.id }));
      await settle(page);

      await expect(page).toHaveScreenshot(`${scene.id}.png`);
    });
  }

  /**
   * A packing boundary: 9 days 23:59:59 of real remaining time, which the
   * seven rings read as `239:59:59` — hours, not days.
   *
   * This frame is where a digit-packing error shows up visually, and it is a
   * regression guard for a specific bug: the rings used to be fed a
   * `D HH MM SS` split, so this same instant read `9 23 59 59` on a readout
   * labelled `HHH:MM:SS`. Every digit here is distinct, so an off-by-one
   * anywhere in the packing moves a ring.
   */
  test('carry boundary frame', async ({ page }) => {
    const carryScene = scenes[0]!;
    const remainingMs = 9 * 86_400_000 + 23 * 3_600_000 + 59 * 60_000 + 59 * 1_000;
    const mockNow = Date.parse(PINNED_TARGET) - remainingMs;

    await gotoApp(
      page,
      deterministicOptions({ scene: carryScene.id, mockNow, target: PINNED_TARGET }),
    );
    await settle(page);

    // Assert the frame really is the boundary before trusting the pixels.
    expect(await readDigits(page)).toEqual([2, 3, 9, 5, 9, 5, 9].slice(-carryScene.rings.count));

    await expect(page).toHaveScreenshot('carry-boundary.png');
  });
});
