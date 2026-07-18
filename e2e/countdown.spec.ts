import { expect, test } from '@playwright/test';
import {
  PINNED_NOW,
  PINNED_TARGET,
  SELECTOR,
  TICKING_TARGET,
  gotoApp,
  readDigits,
  waitForFrames,
} from './support/app.js';

/**
 * The countdown readout.
 *
 * Assertions here are deliberately loose — "it changed", "it has the right
 * shape" — never exact strings. The time module is being rewritten in
 * parallel, and this suite must not encode its current formatting.
 */

test.describe('countdown readout', () => {
  test('displays a readout and advances over time', async ({ page }) => {
    await gotoApp(page, { mockNow: PINNED_NOW, mockNowMode: 'advance', target: PINNED_TARGET });

    const readout = page.locator(SELECTOR.countdown);
    await expect(readout).toBeVisible();

    const initial = (await readout.textContent())?.trim() ?? '';
    expect(initial.length).toBeGreaterThan(0);
    // Shape only: some digits and some separators, whatever the format becomes.
    expect(initial).toMatch(/\d/);

    await expect
      .poll(async () => (await readout.textContent())?.trim(), {
        message: 'the countdown readout never changed — is the clock advancing?',
        timeout: 15_000,
      })
      .not.toBe(initial);
  });

  test('advances the digits handed to the rings', async ({ page }) => {
    // A target under the 999-hour cap: beyond it the rings correctly pin at
    // 999:59:59 and hold still, which would make "did it move" unanswerable.
    await gotoApp(page, { mockNow: PINNED_NOW, mockNowMode: 'advance', target: TICKING_TARGET });

    const initial = await readDigits(page);
    expect(initial.length).toBeGreaterThan(0);
    for (const digit of initial) expect(digit).toBeGreaterThanOrEqual(0);
    for (const digit of initial) expect(digit).toBeLessThanOrEqual(9);

    await expect
      .poll(async () => (await readDigits(page)).join(''), {
        message: 'ring digits never changed — the render loop may be stalled',
        timeout: 15_000,
      })
      .not.toBe(initial.join(''));
  });

  test('a frozen clock holds the readout still', async ({ page }) => {
    await gotoApp(page, {
      mockNow: PINNED_NOW,
      mockNowMode: 'frozen',
      target: PINNED_TARGET,
      noMotion: true,
    });

    const before = await readDigits(page);
    const textBefore = await page.locator(SELECTOR.countdown).textContent();

    // Frames keep being drawn; only the clock is pinned. This is what makes
    // screenshots reproducible without stopping the renderer.
    await waitForFrames(page, 30);

    expect(await readDigits(page)).toEqual(before);
    expect(await page.locator(SELECTOR.countdown).textContent()).toBe(textBefore);
  });

  test('honours an explicit ?target', async ({ page }) => {
    await gotoApp(page, {
      mockNow: PINNED_NOW,
      target: PINNED_TARGET,
      noMotion: true,
    });

    const target = await page.evaluate(() => window.__clock?.target());
    expect(target?.source).toBe('url');
    expect(target?.atMs).toBe(Date.parse(PINNED_TARGET));

    const countdown = await page.evaluate(() => window.__clock?.countdown());
    expect(countdown?.elapsed).toBe(false);
    expect(countdown?.totalMs).toBe(Date.parse(PINNED_TARGET) - PINNED_NOW);
  });
});
