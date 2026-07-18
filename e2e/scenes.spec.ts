import { expect, test } from '@playwright/test';
import {
  SELECTOR,
  deterministicOptions,
  gotoApp,
  openSettings,
  readDigits,
  readRendererState,
  readSceneId,
  watchConsole,
} from './support/app.js';
import { sceneRegistry } from '../src/scene/scenes/index.js';

/**
 * Scene switching via `?scene=`.
 *
 * Scene ids come from the registry rather than string literals, so adding or
 * renaming a scene updates this suite automatically — and a new scene is
 * checked for "actually renders" for free.
 */

const DEFAULT_SCENE_ID = sceneRegistry.defaultSceneId;
const ALL_SCENES = sceneRegistry.list();

test.describe('scene selection', () => {
  test('defaults to the registry default scene', async ({ page }) => {
    await gotoApp(page);

    expect(await readSceneId(page)).toBe(DEFAULT_SCENE_ID);
    expect((await readRendererState(page)).sceneId).toBe(DEFAULT_SCENE_ID);
  });

  for (const scene of ALL_SCENES) {
    test(`?scene=${scene.id} renders ${scene.name}`, async ({ page }) => {
      const console_ = watchConsole(page);

      await gotoApp(page, { scene: scene.id });

      expect(await readSceneId(page)).toBe(scene.id);

      const state = await readRendererState(page);
      expect(state.sceneId).toBe(scene.id);
      expect(state.drawCalls, `${scene.id} presented an empty frame`).toBeGreaterThan(0);
      expect(state.triangles).toBeGreaterThan(0);

      // Ring count is scene data, and the digit packing must follow it.
      expect(await readDigits(page)).toHaveLength(scene.rings.count);

      // The picker reflects the URL. It lives in the settings drawer, which is
      // collapsed until asked for.
      await openSettings(page);
      await expect(page.locator(SELECTOR.sceneSelect)).toHaveValue(scene.id);

      expect(console_.errors).toEqual([]);
    });
  }

  test('falls back to the default for an unknown ?scene without erroring', async ({ page }) => {
    const console_ = watchConsole(page);

    await gotoApp(page, { scene: 'no-such-scene-42' });

    expect(await readSceneId(page)).toBe(DEFAULT_SCENE_ID);

    const state = await readRendererState(page);
    expect(state.sceneId).toBe(DEFAULT_SCENE_ID);
    expect(state.drawCalls).toBeGreaterThan(0);
    expect(console_.errors).toEqual([]);
  });

  test('the picker switches scenes and rewrites the URL', async ({ page }) => {
    test.skip(ALL_SCENES.length < 2, 'needs at least two registered scenes');

    const first = ALL_SCENES[0]!;
    const second = ALL_SCENES[1]!;

    const console_ = watchConsole(page);
    await gotoApp(page, { scene: first.id });

    await openSettings(page);
    await page.locator(SELECTOR.sceneSelect).selectOption(second.id);

    await expect.poll(async () => readSceneId(page)).toBe(second.id);
    await expect.poll(async () => (await readRendererState(page)).sceneId).toBe(second.id);
    // Switching disposes the old view and builds a new one; it must still draw.
    await expect.poll(async () => (await readRendererState(page)).drawCalls).toBeGreaterThan(0);

    expect(new URL(page.url()).searchParams.get('scene')).toBe(second.id);

    // The store's scene id changes synchronously, but the digits are only
    // repacked to the new ring count on the next animation frame — so poll
    // rather than read once.
    await expect
      .poll(async () => (await readDigits(page)).length, {
        message: 'digits were never repacked to the new scene ring count',
      })
      .toBe(second.rings.count);

    expect(console_.errors).toEqual([]);
  });
});

test.describe('background preference', () => {
  test('?bg=backdrop swaps the panorama for the authored gradient', async ({ page }) => {
    await gotoApp(page, deterministicOptions({ background: 'backdrop' }));
    const state = await readRendererState(page);
    expect(state.panoramaBackground).toBe(false);
  });

  test('the deterministic default shows the panorama', async ({ page }) => {
    // High tier, no override: the HDR environment is the backdrop. This is the
    // other half of the assertion above — proof the override changed something.
    await gotoApp(page, deterministicOptions({}));
    const state = await readRendererState(page);
    expect(state.panoramaBackground).toBe(true);
  });
});
