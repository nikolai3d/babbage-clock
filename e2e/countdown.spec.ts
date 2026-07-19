import { expect, test } from '@playwright/test';
import {
  PINNED_NOW,
  PINNED_TARGET,
  SELECTOR,
  TICKING_TARGET,
  gotoApp,
  openSettings,
  readDigits,
  readRingAngles,
  waitForFrames,
} from './support/app.js';
import { ringAngleForDigit } from '../src/geometry/ringLayout.js';
import type { MechanismEvent } from '../src/mechanism/index.js';

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

  test('applying a new target travels rather than teleporting', async ({ page }) => {
    // The rings should spin to a new value, not cut to it — and the travel is
    // entirely in the ring *angles*: the logical digits update the instant the
    // target is applied.
    //
    // This used to compare three full-page screenshots around the spin, which
    // was wrong twice over. Every moving part is a function of the mocked
    // clock, so the frozen clock this test pinned froze the seek animation at
    // t = 0 — the drums never moved at all, and the comparison passed on
    // incidental DOM differences. And under SwiftShader a screenshot costs
    // whole seconds, so after a slow boot the trio regularly blew the 45 s
    // test budget. Hence: an advancing clock, so the travel genuinely plays,
    // and mechanism state instead of pixels.
    //
    // "It travelled" is asserted from the mechanism's event, not from angles
    // sampled per frame: a contended SwiftShader runner can render two frames
    // more than a second apart, bracketing the whole spin — the viewer's
    // frames genuinely skip from the old reading to the new one, and no
    // sampling scheme can observe what was never drawn. The event is
    // unmissable at any frame rate (each one is created on a rendered frame
    // and stays current until the next), and it is the decision itself: a
    // teleport is exactly a seek with no duration, or no seek at all.
    await gotoApp(page, { mockNow: PINNED_NOW, mockNowMode: 'advance', target: TICKING_TARGET });

    // The tens-of-hours ring: `010:30:00 -> 021:15:00` turns it 1 -> 2.
    // Chosen because natural ticking cannot touch it inside this test — the
    // hours reading holds 021 for the rest of the hour — so every angle change
    // on this ring belongs to the travel.
    const TRAVEL_RING = 1;
    expect(
      (await readRingAngles(page))[TRAVEL_RING],
      'expected the tens-of-hours ring at rest on 1 before the apply',
    ).toBeCloseTo(ringAngleForDigit(1), 5);

    // Collect every seek the mechanism plans, from before the apply so none
    // can slip past. Reading `lastMechanismEvent` once per animation frame is
    // lossless: events are created at most once per rendered frame — each a
    // fresh object, so identity distinguishes consecutive events — and the
    // current one cannot be replaced before this callback has seen it.
    //
    // Seeks are not rare here, and that is why they are collected rather than
    // assumed to be the apply's: when a contended runner takes more than a
    // second between frames, the tick sequence jumps by two or more and the
    // mechanism resolves the catch-up as a quiet seek of the low rings. A
    // catch-up *can* even reach the tens-of-hours ring — `planSeek` re-aims
    // any ring still moving — but only by re-aiming it mid-travel, after the
    // apply set it moving; an idle ring whose digit did not change is skipped.
    // So the FIRST seek to touch that ring is always the apply's, and the
    // selection below relies on collection order for exactly that reason.
    await page.evaluate(() => {
      const api = window.__clock;
      if (!api) throw new Error('window.__clock is not installed — is ?testApi set?');
      const seeks: MechanismEvent[] = [];
      let last: MechanismEvent | null = null;
      const record = (): void => {
        const event = api.lastMechanismEvent();
        if (event && event !== last) {
          last = event;
          if (event.kind === 'seek') seeks.push(event);
        }
        requestAnimationFrame(record);
      };
      requestAnimationFrame(record);
      window.__travelSeeks = seeks;
    });

    await openSettings(page);
    // Playwright's fill() rejects seconds on a datetime-local input.
    await page.locator(SELECTOR.targetInput).fill('2026-06-16T09:15');
    await page.locator(SELECTOR.targetApply).click();

    // The apply must resolve through a seek that turns the travel ring — a
    // target change routed through a mechanism reset would adopt the new
    // reading instantly and emit nothing.
    await expect
      .poll(
        () =>
          page.evaluate(
            (ring) =>
              (window.__travelSeeks ?? []).some((seek) =>
                seek.motions.some((motion) => motion.ring === ring),
              ),
            TRAVEL_RING,
          ),
        {
          message: 'applying the target never made the mechanism seek the hours rings',
          timeout: 15_000,
        },
      )
      .toBe(true);

    const seek = (await page.evaluate(
      (ring) =>
        (window.__travelSeeks ?? []).find((candidate) =>
          candidate.motions.some((motion) => motion.ring === ring),
        ),
      TRAVEL_RING,
    )) as MechanismEvent;

    // The travel itself: the correction turns the ring over a real duration.
    // A teleport is exactly this duration being zero.
    expect(seek.durationMs, 'the rings cut straight to the new value').toBeGreaterThan(0);
    const travelMotion = seek.motions.find((motion) => motion.ring === TRAVEL_RING);
    expect(travelMotion?.toDigit, 'the seek did not aim the tens-of-hours ring at 2').toBe(2);
    expect(
      Math.abs(travelMotion?.deltaAngle ?? 0),
      'the seek planned no rotation for the tens-of-hours ring',
    ).toBeGreaterThan(0);

    // And the rendered rings actually arrive: the angle written to the scene
    // graph comes to rest exactly on the new digit and stays there.
    //
    // Exact equality, not toBeCloseTo. The mechanism re-normalises every idle
    // ring to exactly `ringAngleForDigit(digit)` (its `settle()`), and that
    // function is pure IEEE arithmetic, so Node and the page compute the
    // identical double. A tolerance would quietly re-open a flake: the settle
    // wobble passes within a few µrad of the canonical angle while still
    // moving, so a tolerant poll could latch a transient mid-flight sample
    // that the stay-at-rest check below would then flag as movement.
    await expect
      .poll(async () => (await readDigits(page))[TRAVEL_RING], {
        message: 'the tens-of-hours ring never took the new reading',
        timeout: 15_000,
      })
      .toBe(2);
    await expect
      .poll(async () => (await readRingAngles(page))[TRAVEL_RING], {
        message: 'the rings never came to rest on the new reading',
        timeout: 20_000,
      })
      .toBe(ringAngleForDigit(2));
    await waitForFrames(page, 3);
    expect((await readRingAngles(page))[TRAVEL_RING], 'the ring did not stay at rest').toBe(
      ringAngleForDigit(2),
    );
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

declare global {
  interface Window {
    /**
     * Every seek the mechanism has planned since the travel spec installed its
     * in-page collector, oldest first. Spec-owned, like `__loseContext` in
     * `fallback.spec.ts`.
     */
    __travelSeeks?: MechanismEvent[];
  }
}
