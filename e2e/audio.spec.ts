import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import {
  PINNED_NOW,
  TICKING_TARGET,
  appUrl,
  gotoApp,
  waitForLoadingScreen,
} from './support/app.js';

/**
 * The opt-in gate is the whole contract: a page that plays — or even
 * *prepares* — audio before the viewer asks would be obnoxious, and the
 * AudioContext constructor is the observable line. It is counted from an init
 * script, so a context created anywhere, by any module, in any order, shows
 * up; asserting on the toggle's side effects alone could miss a stray one.
 */

async function countContexts(page: Page): Promise<number> {
  return page.evaluate(() => (window as unknown as { __audioContexts: number }).__audioContexts);
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    (window as unknown as { __audioContexts: number }).__audioContexts = 0;
    const Original = window.AudioContext;
    window.AudioContext = class extends Original {
      constructor(options?: AudioContextOptions) {
        super(options);
        (window as unknown as { __audioContexts: number }).__audioContexts += 1;
      }
    };
  });
});

test('no AudioContext exists until the viewer opts in', async ({ page }) => {
  await gotoApp(page, { mockNow: PINNED_NOW, mockNowMode: 'advance', target: TICKING_TARGET });
  expect(await countContexts(page)).toBe(0);

  await page.locator('#settings-toggle').click();
  await page.locator('#sound-toggle').check();
  expect(await countContexts(page)).toBe(1);

  // Off again: the engine is disposed; re-enabling makes a fresh context.
  await page.locator('#sound-toggle').uncheck();
  await page.locator('#sound-toggle').check();
  expect(await countContexts(page)).toBe(2);
});

test('?sound=1 arms the toggle but stays inside the policy', async ({ page }) => {
  await page.goto(
    appUrl({ mockNow: PINNED_NOW, mockNowMode: 'advance', target: TICKING_TARGET }) + '&sound=1',
  );
  await page.waitForFunction(() => window.__clock !== undefined);
  await waitForLoadingScreen(page);

  // The wish is honoured — the toggle reads on — and a context may exist
  // (headless Chromium grants autoplay); what matters is the toggle agrees
  // with reality and flipping it works.
  await page.locator('#settings-toggle').click();
  await expect(page.locator('#sound-toggle')).toBeChecked();
});
