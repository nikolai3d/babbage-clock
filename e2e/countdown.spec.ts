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
    // A target under the 999-hour cap. Past the cap the hours pin at 999 while
    // the lower rings keep running — see the default-target test below, which
    // is the case that actually ships.
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

  test('advances on the default target, with no ?target= supplied', async ({ page }) => {
    // The case every other tick test missed. The default target is the next New
    // Year — thousands of hours out, so it is always clamped — and clamping used
    // to pin the whole value, not just the hours. The landing view was therefore
    // a countdown clock whose rings never moved, and no test could see it
    // because they all pin a target inside the cap first.
    await gotoApp(page, { mockNow: PINNED_NOW, mockNowMode: 'advance' });

    const remaining = await page.evaluate(() => window.__clock?.remaining());
    expect(remaining?.clamped, 'the default target should exercise the clamp').toBe(true);

    const initial = await readDigits(page);
    await expect
      .poll(async () => (await readDigits(page)).join(''), {
        message: 'the default view never moved — the clamp has frozen the rings again',
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
    //
    // Ten rather than thirty since image-based lighting landed: a frame costs
    // roughly three times as much under SwiftShader, and two CI workers share
    // one runner between them, so thirty no longer fits the 45 s test timeout.
    // Both assertions below are unchanged, and ten frames is still several
    // seconds of continuous rendering — more wall-clock observation than thirty
    // bought on the cheaper renderer this number was picked for.
    await waitForFrames(page, 10);

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
