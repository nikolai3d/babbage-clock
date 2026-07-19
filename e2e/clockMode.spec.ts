import { expect, test } from '@playwright/test';
import {
  PINNED_NOW,
  SELECTOR,
  deterministicOptions,
  gotoApp,
  openSettings,
  readDigits,
} from './support/app.js';

/**
 * Clock mode. `PINNED_NOW` is 2026-06-15T12:00:00Z and the container runs in
 * UTC, so every reading below is exact.
 */

test('?mode=clock reads the current time on any scene, zero-padded', async ({ page }) => {
  // The seven-ring countdown scene in clock mode: HHMMSS with a leading zero.
  await gotoApp(page, { ...deterministicOptions({}), mode: 'clock' });
  expect(await readDigits(page)).toEqual([0, 1, 2, 0, 0, 0, 0]);
});

test('the clock scene is native six-ring and rolls forward', async ({ page }) => {
  await gotoApp(page, {
    mockNow: PINNED_NOW,
    mockNowMode: 'advance',
    scene: 'copper-padlock-clock',
    mockSync: true,
  });
  expect(await readDigits(page)).toHaveLength(6);

  // Forward: the seconds figure grows.
  const before = await readDigits(page);
  await expect
    .poll(async () => (await readDigits(page)).join(''), { timeout: 15_000 })
    .not.toBe(before.join(''));
  const after = await readDigits(page);
  const seconds = (digits: readonly number[]): number => digits[4]! * 10 + digits[5]!;
  expect(seconds(after)).toBeGreaterThan(seconds(before));
});

test('?tz= moves the reading and ?h12 folds it', async ({ page }) => {
  // 12:00 UTC is 21:00 in Tokyo; in 12-hour form the rings read 09:00:00.
  await gotoApp(page, {
    ...deterministicOptions({ scene: 'copper-padlock-clock' }),
    mode: 'clock',
    tz: 'Asia/Tokyo',
  });
  expect(await readDigits(page)).toEqual([2, 1, 0, 0, 0, 0]);

  await gotoApp(page, {
    ...deterministicOptions({ scene: 'copper-padlock-clock' }),
    mode: 'clock',
    tz: 'Asia/Tokyo',
    h12: true,
  });
  expect(await readDigits(page)).toEqual([0, 9, 0, 0, 0, 0]);
});

test('clock mode hides the countdown affordances and shows the time', async ({ page }) => {
  await gotoApp(page, { ...deterministicOptions({ scene: 'copper-padlock-clock' }) });

  await expect(page.locator('#countdown')).toHaveText('12:00:00');
  await expect(page.locator('#target-label')).toContainText('time');

  await page.locator('#settings-toggle').click();
  await expect(page.locator('#target-form')).toBeHidden();
  await expect(page.locator('#target-echo')).toBeHidden();
});

test('the drawer offers a zone control in clock mode, and it moves the reading', async ({
  page,
}) => {
  await gotoApp(page, { ...deterministicOptions({ scene: 'copper-padlock-clock' }) });
  // 12:00 UTC on the rings before any change.
  expect(await readDigits(page)).toEqual([1, 2, 0, 0, 0, 0]);

  await openSettings(page);
  // The zone control stands in for the hidden target form.
  await expect(page.locator(SELECTOR.targetForm)).toBeHidden();
  const zone = page.locator(SELECTOR.clockZoneInput);
  await expect(zone).toBeVisible();

  // Search and commit through the combobox.
  await zone.click();
  await zone.fill('Tokyo');
  await page.locator(`${SELECTOR.clockZoneListbox} [data-zone="Asia/Tokyo"]`).click();
  await expect(zone).toHaveValue('Asia/Tokyo');

  // The rings and the HUD follow within a tick: 12:00 UTC is 21:00 in Tokyo.
  await expect.poll(async () => (await readDigits(page)).join('')).toBe('210000');
  await expect(page.locator(SELECTOR.targetLabel)).toHaveText('Asia/Tokyo time');

  // The change is shareable — `?tz=` carries the zone — and the countdown
  // target kept its instant: midnight UTC re-anchored as 09:00 Tokyo.
  expect(page.url()).toContain('tz=Asia/Tokyo');
  expect(page.url()).toContain('target=2027-01-01T09:00:00');
});

test('the zone control stays out of the countdown drawer', async ({ page }) => {
  await gotoApp(page, deterministicOptions());
  await openSettings(page);

  await expect(page.locator(SELECTOR.targetForm)).toBeVisible();
  await expect(page.locator(SELECTOR.clockZoneField)).toBeHidden();
});
