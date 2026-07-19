import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import {
  PINNED_NOW,
  SELECTOR,
  TICKING_TARGET,
  appUrl,
  deterministicOptions,
  focusedId,
  gotoApp,
  openSettings,
  readRendererState,
  tabTo,
  waitForFrames,
} from './support/app.js';
import type { Page } from '@playwright/test';

/**
 * Accessibility.
 *
 * Three things are checked here that no screenshot can express: that the page
 * passes automated WCAG rules in each of its states, that the countdown reaches
 * a screen reader as words on a bearable schedule, and that every setting can
 * be operated without a pointer.
 *
 * `docs/accessibility.md` covers what these checks cannot — the manual screen
 * reader pass, and why the cadence is what it is.
 */

/**
 * The rule sets we hold ourselves to.
 *
 * Best-practice rules are deliberately excluded: they flag things like "all
 * content should be inside a landmark", which is a defensible opinion but not
 * WCAG, and folding them in would make the suite fail for reasons unrelated to
 * anyone's ability to use the page.
 */
const WCAG_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];

function axe(page: Page): AxeBuilder {
  return new AxeBuilder({ page }).withTags(WCAG_TAGS);
}

/** Prints the offending selectors, so a CI failure says what to fix. */
function describeViolations(violations: { id: string; nodes: { target: unknown[] }[] }[]): string {
  return violations
    .map(
      (violation) =>
        `${violation.id}: ${violation.nodes.map((n) => n.target.join(' ')).join(', ')}`,
    )
    .join('\n');
}

test.describe('axe', () => {
  test('the clock with the drawer closed has no violations', async ({ page }) => {
    await gotoApp(page, deterministicOptions());

    const results = await axe(page).analyze();
    expect(describeViolations(results.violations)).toBe('');
  });

  test('the settings drawer open has no violations', async ({ page }) => {
    await gotoApp(page, deterministicOptions());
    await openSettings(page);

    const results = await axe(page).analyze();
    expect(describeViolations(results.violations)).toBe('');
  });

  test('the timezone listbox has no violations while open', async ({ page }) => {
    await gotoApp(page, deterministicOptions());
    await openSettings(page);

    await page.locator(SELECTOR.tzInput).click();
    await page.locator(SELECTOR.tzInput).fill('Tokyo');
    await expect(page.locator(SELECTOR.tzListbox)).toBeVisible();

    const results = await axe(page).analyze();
    expect(describeViolations(results.violations)).toBe('');
  });

  test('the drawer in clock mode has no violations and focuses the zone picker', async ({
    page,
  }) => {
    await gotoApp(page, deterministicOptions({ scene: 'copper-padlock-clock' }));
    await openSettings(page);

    // Clock mode hides the target form, so focus lands on the first control
    // there is: the reading-zone picker.
    expect(await focusedId(page)).toBe('clock-zone-input');

    const results = await axe(page).analyze();
    expect(describeViolations(results.violations)).toBe('');
  });

  test('a toast has no violations', async ({ page }) => {
    await gotoApp(page, deterministicOptions());
    await openSettings(page);

    // Either outcome shows a toast: the clipboard write succeeds, or it is
    // refused and the panel says to copy the link by hand.
    await page.locator(SELECTOR.shareButton).click();
    await expect(page.locator(`${SELECTOR.toastRegion} .toast`)).toHaveCount(1);

    const results = await axe(page).analyze();
    expect(describeViolations(results.violations)).toBe('');
  });

  /**
   * The loading screen is authored in `index.html` so it paints before any
   * script. Blocking the bundle leaves it up indefinitely, which is the only
   * way to scan it deterministically — and it scans the markup as shipped.
   */
  test('the loading screen has no violations', async ({ page }) => {
    await page.route('**/*.js', (route) => route.abort());
    await page.goto(appUrl());

    await expect(page.locator(SELECTOR.loadingScreen)).toBeVisible();

    const results = await axe(page).analyze();
    expect(describeViolations(results.violations)).toBe('');
  });
});

test.describe('the countdown as text', () => {
  test('states the remaining time and the target on load', async ({ page }) => {
    await gotoApp(page, deterministicOptions({ target: TICKING_TARGET }));

    const live = page.locator(SELECTOR.announcement);
    // Polite, atomic, and not the `role="timer"` element: exactly one live
    // region carries the countdown.
    await expect(live).toHaveAttribute('aria-live', 'polite');
    await expect(live).toHaveAttribute('aria-atomic', 'true');
    await expect(page.locator(SELECTOR.countdown)).toHaveAttribute('aria-live', 'off');
    await expect(page.locator(SELECTOR.countdown)).toHaveAttribute('role', 'timer');

    // Words, not HHH:MM:SS, and it names what it is counting down to.
    await expect(live).toContainText('Counting down to');
    await expect(live).toContainText('remaining.');
    await expect(live).toContainText(/\d+ hours?/);
  });

  /**
   * The cadence is the whole point of the mirror: `#countdown` changes four
   * times a second, and a live region that followed it would make a screen
   * reader useless. This watches the real thing tick for several seconds and
   * insists the announcement does not move with it.
   */
  test('does not re-announce every second', async ({ page }) => {
    await gotoApp(page, {
      mockNow: PINNED_NOW,
      mockNowMode: 'advance',
      target: TICKING_TARGET,
      noMotion: true,
    });

    const live = page.locator(SELECTOR.announcement);
    const readout = page.locator(SELECTOR.countdown);

    const firstAnnouncement = await live.textContent();
    const firstReadout = await readout.textContent();

    // Long enough for several seconds to pass on a countdown that is hours out,
    // so the readout has certainly moved and the announcement must not have.
    await page.waitForTimeout(4_000);

    expect(await readout.textContent()).not.toBe(firstReadout);
    expect(await live.textContent()).toBe(firstAnnouncement);
  });

  test('announces expiry', async ({ page }) => {
    // Three seconds before the target, ticking for real: the app crosses
    // expiry on its own rather than being told it has.
    const target = '2026-06-15T12:00:03Z';
    await gotoApp(page, {
      mockNow: PINNED_NOW,
      mockNowMode: 'advance',
      target,
      noMotion: true,
    });

    await expect(page.locator(SELECTOR.announcement)).toContainText('Time is up.', {
      timeout: 15_000,
    });
  });
});

test.describe('reduced motion', () => {
  // Applied before navigation, so the app sees the preference on its first
  // read rather than as a change. It persists across `goto`.
  test.beforeEach(async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
  });

  test('switches motion off through the same path as ?nomotion', async ({ page }) => {
    await gotoApp(page, { mockNow: PINNED_NOW, target: TICKING_TARGET });

    const state = await readRendererState(page);
    expect(state.motion, 'prefers-reduced-motion did not reach the renderer').toBe(false);

    // And it got there via the media query, not the URL: the hook is untouched.
    const hooks = await page.evaluate(() => window.__clock?.hooks());
    expect(hooks?.motion).toBe(true);
  });

  test('keeps the countdown correct with motion off', async ({ page }) => {
    await gotoApp(page, {
      mockNow: PINNED_NOW,
      mockNowMode: 'advance',
      target: TICKING_TARGET,
    });

    const before = await page.locator(SELECTOR.countdown).textContent();
    await waitForFrames(page, 5);
    await expect(page.locator(SELECTOR.countdown)).not.toHaveText(before ?? '');
  });
});

test('honours prefers-reduced-motion turned on mid-session', async ({ page }) => {
  // Motion deliberately left on — `deterministicOptions()` would set
  // `?nomotion` and there would be nothing for the media query to change.
  await gotoApp(page, { mockNow: PINNED_NOW, target: TICKING_TARGET });
  expect((await readRendererState(page)).motion).toBe(true);

  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expect
    .poll(async () => (await readRendererState(page)).motion, {
      message: 'the renderer ignored a mid-session reduced-motion change',
    })
    .toBe(false);

  // Still drawing, still on the right instant — motion off is not paused.
  await waitForFrames(page, 3);
  expect((await readRendererState(page)).drawCalls).toBeGreaterThan(0);
});

test.describe('keyboard only', () => {
  test('orbits the view from the keyboard', async ({ page }) => {
    await gotoApp(page, deterministicOptions());

    // The canvas is a tab stop precisely so orbiting is not pointer-only.
    await page.keyboard.press('Tab');
    expect(await focusedId(page)).toBe('scene-canvas');

    const start = (await readRendererState(page)).cameraPosition;
    await page.keyboard.press('ArrowLeft');
    await page.keyboard.press('ArrowLeft');
    const orbited = (await readRendererState(page)).cameraPosition;
    expect(orbited).not.toEqual(start);

    await page.keyboard.press('Home');
    const reset = (await readRendererState(page)).cameraPosition;
    expect(reset[0]).toBeCloseTo(start[0], 4);
    expect(reset[2]).toBeCloseTo(start[2], 4);

    // And nothing traps focus there: Tab moves on to the settings button.
    await page.keyboard.press('Tab');
    expect(await focusedId(page)).toBe('settings-toggle');
  });

  test('completes the whole settings flow without a pointer', async ({ page }) => {
    await gotoApp(page, deterministicOptions());

    // Open the drawer from the keyboard; focus follows it in.
    await tabTo(page, 'settings-toggle');
    await page.keyboard.press('Enter');
    await expect(page.locator(SELECTOR.settingsPanel)).toBeVisible();
    expect(await focusedId(page)).toBe('target-input');

    // Fill the date. `datetime-local` is a segmented control: ArrowUp sets the
    // segment under the caret and ArrowRight moves to the next one. Driving it
    // that way rather than typing digits keeps the test independent of the
    // locale's segment order, which is what the digits would have to match.
    for (let segment = 0; segment < 7; segment += 1) {
      await page.keyboard.press('ArrowUp');
      await page.keyboard.press('ArrowRight');
    }
    const entered = await page.locator(SELECTOR.targetInput).inputValue();
    expect(entered, 'the date field was not fillable from the keyboard').toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/,
    );

    // Pick a zone through the combobox: focusing it selects the current value,
    // so typing searches; then arrow through the list and commit with Enter.
    await tabTo(page, 'tz-input');
    await page.keyboard.type('Tokyo');
    await expect(page.locator(SELECTOR.tzListbox)).toBeVisible();
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowUp');
    await page.keyboard.press('Enter');
    await expect(page.locator(SELECTOR.tzInput)).toHaveValue('Asia/Tokyo');

    await tabTo(page, 'target-apply');
    await page.keyboard.press('Enter');
    // The applied target comes back through the store and into the echo, which
    // is the proof that the whole intent round trip happened without a pointer.
    await expect(page.locator('#target-echo')).toContainText('Asia/Tokyo');
    await expect(page.locator(SELECTOR.targetInput)).toHaveValue(entered);
    await expect(page.locator(SELECTOR.countdown)).not.toBeEmpty();

    // Switch scene from the keyboard. Type-ahead rather than ArrowDown: on a
    // closed `<select>` the arrow keys open the native popup on some platforms
    // and change the value on others, and only one of those is testable.
    await tabTo(page, 'scene-select');
    await page.keyboard.press('S'); // "Slate Orrery"
    await expect(page.locator(SELECTOR.sceneSelect)).toHaveValue('slate-orrery');
    await expect
      .poll(async () => (await readRendererState(page)).sceneId, {
        message: 'the keyboard scene change never reached the renderer',
      })
      .toBe('slate-orrery');

    // Lighting mood, same way.
    await tabTo(page, 'mood-select');
    // The whole word, because a bare "N" lands on "No environment" first.
    await page.keyboard.type('Night');
    await expect(page.locator(SELECTOR.moodSelect)).toHaveValue('night');

    // Copy the share link.
    await tabTo(page, 'share-button');
    await page.keyboard.press('Enter');
    await expect(page.locator(`${SELECTOR.toastRegion} .toast`)).toHaveCount(1);

    // Escape closes the drawer and hands focus back to the button that opened
    // it, so a keyboard user is never stranded behind a closed panel.
    await page.keyboard.press('Escape');
    await expect(page.locator(SELECTOR.settingsPanel)).toBeHidden();
    expect(await focusedId(page)).toBe('settings-toggle');
  });
});

test('survives 200% browser zoom', async ({ page }) => {
  // 200% zoom halves the CSS viewport; emulating the resulting size is the
  // portable way to check the layout, since Playwright cannot set page zoom.
  await page.setViewportSize({ width: 640, height: 360 });
  await gotoApp(page, deterministicOptions());
  await openSettings(page);

  // Nothing may overflow the viewport horizontally — the drawer becomes a
  // bottom sheet at this width and scrolls vertically inside itself.
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - window.innerWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);

  const panel = page.locator(SELECTOR.settingsPanel);
  await expect(panel).toBeVisible();
  const box = await panel.boundingBox();
  expect(box?.height ?? 0).toBeLessThanOrEqual(360);

  // The controls are still reachable and operable at this size.
  await expect(page.locator(SELECTOR.shareButton)).toBeVisible();

  const results = await axe(page).analyze();
  expect(describeViolations(results.violations)).toBe('');
});
