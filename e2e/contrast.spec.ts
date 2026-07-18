import { PNG } from 'pngjs';
import { expect, test } from '@playwright/test';
import { deterministicOptions, gotoApp } from './support/app.js';
import { ENVIRONMENT_PRESETS } from '../src/scene/environment.js';
import type { Locator, Page } from '@playwright/test';

/**
 * WCAG contrast of the 2D chrome over the backdrops viewers actually get.
 *
 * The accessibility bead measured contrast against a synthetic worst case and
 * fixed what failed; this measures the real thing. Every mood renders a
 * different scene behind the chrome — the measured drum-vs-numeral contrast
 * already ranges 2.8 to 5.2 across moods — and the chrome's guarantee rests on
 * its semi-opaque panels keeping the scene out. That is an assumption worth a
 * test: a future styling change that thins a panel, or a mood bright enough to
 * bleed through one, should fail here rather than ship.
 *
 * Method: screenshot each mood deterministically, sample the element's padding
 * ring (see {@link panelLuminance} for why not the whole box), and compute the
 * WCAG ratio against the element's computed text colour. 4.5:1 — AA for
 * normal text — is asserted with no allowance. Measured headroom at adoption:
 * the worst cell was the status strip over sunny-day at 5.4:1, and the
 * readout never dropped below 8.4:1 in any mood.
 */

function luminance(r: number, g: number, b: number): number {
  const channel = (value: number): number => {
    const scaled = value / 255;
    return scaled <= 0.03928 ? scaled / 12.92 : Math.pow((scaled + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

function contrast(l1: number, l2: number): number {
  const [dark, light] = l1 < l2 ? [l1, l2] : [l2, l1];
  return (light + 0.05) / (dark + 0.05);
}

/**
 * Mean luminance of an edge ring just inside a box.
 *
 * The ring — the outer few pixels of the element, inset past any border — is
 * the element's padding: pure panel-over-scene, no glyphs. Averaging the whole
 * box instead would mix the text into its own background, which under-measures
 * exactly the text-dense elements (the countdown readout is mostly digit
 * pixels) this spec most cares about.
 */
function panelLuminance(
  png: PNG,
  box: { x: number; y: number; width: number; height: number },
): number {
  const inset = 3;
  const ring = 4;
  let total = 0;
  let count = 0;
  const x0 = Math.max(0, Math.floor(box.x) + inset);
  const y0 = Math.max(0, Math.floor(box.y) + inset);
  const x1 = Math.min(png.width, Math.ceil(box.x + box.width) - inset);
  const y1 = Math.min(png.height, Math.ceil(box.y + box.height) - inset);
  for (let y = y0; y < y1; y += 1) {
    for (let x = x0; x < x1; x += 1) {
      const inRing = x < x0 + ring || x >= x1 - ring || y < y0 + ring || y >= y1 - ring;
      if (!inRing) continue;
      const i = (png.width * y + x) * 4;
      total += luminance(png.data[i]!, png.data[i + 1]!, png.data[i + 2]!);
      count += 1;
    }
  }
  return count === 0 ? 0 : total / count;
}

async function textLuminance(target: Locator): Promise<number> {
  const rgb = await target.evaluate((element) => {
    const match = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(getComputedStyle(element).color);
    return match ? ([Number(match[1]), Number(match[2]), Number(match[3])] as const) : null;
  });
  if (!rgb) throw new Error('text colour did not parse');
  return luminance(rgb[0], rgb[1], rgb[2]);
}

/** The chrome that sits directly over the scene, with its visible text. */
const CHROME: readonly { name: string; selector: string }[] = [
  { name: 'countdown readout', selector: '#countdown' },
  { name: 'target label', selector: '#target-label' },
  { name: 'clock status strip', selector: '#time-status' },
  { name: 'settings toggle', selector: '#settings-toggle' },
];

async function measure(page: Page): Promise<Record<string, number>> {
  const png = PNG.sync.read(await page.screenshot());
  const results: Record<string, number> = {};
  for (const item of CHROME) {
    const element = page.locator(item.selector);
    const box = await element.boundingBox();
    if (!box) throw new Error(`${item.name} has no box`);
    results[item.name] = contrast(panelLuminance(png, box), await textLuminance(element));
  }
  return results;
}

test.describe('chrome contrast over real moods', () => {
  test.skip(
    process.platform !== 'linux' && !process.env.PW_SCREENSHOTS,
    'pixel sampling matches the screenshot layer: Linux/SwiftShader only',
  );

  for (const preset of ENVIRONMENT_PRESETS) {
    test(`meets AA over ${preset.id}`, async ({ page }) => {
      await gotoApp(page, deterministicOptions({ mood: preset.id }));
      const ratios = await measure(page);
      console.log(`[contrast] ${preset.id}:`, JSON.stringify(ratios));
      for (const [name, ratio] of Object.entries(ratios)) {
        expect(ratio, `${name} over ${preset.id}`).toBeGreaterThanOrEqual(4.5);
      }
    });
  }
});
