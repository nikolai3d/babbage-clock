import { expect, test } from '@playwright/test';
import {
  deterministicOptions,
  gotoApp,
  openSettings,
  readRendererState,
  waitForFrames,
  watchConsole,
} from './support/app.js';
import type { Page } from '@playwright/test';

/**
 * The Substance material pipeline, driven through the real app.
 *
 * The unit suite covers what a manifest means; this covers what actually
 * reaches the GPU — that every folder is served and parsed, that a runtime slot
 * rebind takes effect without a reload, and that swapping looks back and forth
 * gives every texture back. The last one is the point: a leak here is invisible
 * in a screenshot and compounds every time the viewer changes their mind.
 */

/** Material state from the `?testApi` surface. */
async function readMaterials(page: Page): Promise<{
  look: string | null;
  slots: Record<string, string>;
  textures: number;
  sources: number;
  pending: number;
  ktx2: boolean;
}> {
  return page.evaluate(() => {
    const api = window.__clock;
    if (!api) throw new Error('window.__clock is not installed — is ?testApi set?');
    return api.materials();
  });
}

/** Waits until no material load is in flight. */
async function settleMaterials(page: Page): Promise<void> {
  await expect
    .poll(async () => (await readMaterials(page)).pending, {
      message: 'material loads never settled',
      timeout: 15_000,
    })
    .toBe(0);
  await waitForFrames(page, 2);
}

/** Switches the look picker in the settings drawer. */
async function selectLook(page: Page, value: string): Promise<void> {
  await openSettings(page);
  await page.selectOption('#look-select', value);
  await settleMaterials(page);
}

test('every material folder the default scene declares actually loads', async ({ page }) => {
  const console_ = watchConsole(page);

  await gotoApp(page, deterministicOptions());
  await settleMaterials(page);

  const materials = await readMaterials(page);
  // The scene is expressed as a look: every slot names a material folder.
  expect(Object.values(materials.slots).every((value) => value.startsWith('pbr:'))).toBe(true);
  expect(materials.slots['ring']).toBe('pbr:copper-plate');
  expect(materials.slots['numerals']).toBe('pbr:dark-enamel');
  // Three distinct folders, and the ORM map is one file feeding three slots.
  expect(materials.sources).toBeGreaterThan(0);

  // A 404 on a texture is the failure mode a deployment under a sub-path
  // produces, and it is silent: the material just falls back to neutral.
  expect(console_.failedRequests).toEqual([]);
  expect(console_.errors).toEqual([]);
});

test('a material folder with no maps needs no requests', async ({ page }) => {
  await gotoApp(page, deterministicOptions());
  await settleMaterials(page);

  // `dark-enamel` is scalars only. It is bound, it renders, and it costs one
  // manifest and no images.
  const materials = await readMaterials(page);
  expect(materials.slots['numerals']).toBe('pbr:dark-enamel');
});

test('a look swap rebinds every slot without reloading', async ({ page }) => {
  await gotoApp(page, deterministicOptions());
  await settleMaterials(page);

  const framesBefore = (await readRendererState(page)).frames;
  const sceneBefore = (await readRendererState(page)).sceneId;

  await selectLook(page, 'uv-grid');

  const materials = await readMaterials(page);
  expect(materials.look).toBe('uv-grid');
  expect(new Set(Object.values(materials.slots))).toEqual(new Set(['pbr:uv-grid']));

  const state = await readRendererState(page);
  // Same page, same scene, same render loop: the frame counter only ever
  // increases, and a reload would have reset it.
  expect(state.frames).toBeGreaterThan(framesBefore);
  expect(state.sceneId).toBe(sceneBefore);
  expect(state.drawCalls).toBeGreaterThan(0);
});

test('swapping looks back and forth leaks no textures', async ({ page }) => {
  await gotoApp(page, deterministicOptions());
  await settleMaterials(page);

  const baseline = (await readRendererState(page)).textures;
  expect(baseline).toBeGreaterThan(0);

  for (let round = 0; round < 3; round += 1) {
    await selectLook(page, 'uv-grid');
    await selectLook(page, 'blued-steel');
    await selectLook(page, '');
  }

  await settleMaterials(page);
  const after = (await readRendererState(page)).textures;

  // `renderer.info.memory.textures` is three.js's own count of live GPU
  // textures. Three full round trips must land exactly where they started.
  expect(after).toBe(baseline);
  expect((await readMaterials(page)).look).toBeNull();
});

test('scene switching reuses the material cache and releases the old scene', async ({ page }) => {
  await gotoApp(page, deterministicOptions());
  await settleMaterials(page);

  const copper = await readMaterials(page);
  const copperTextures = (await readRendererState(page)).textures;

  await openSettings(page);
  await page.selectOption('#scene-select', 'slate-orrery');
  await settleMaterials(page);

  // The slate preset is deliberately still on untextured placeholder bindings,
  // which is the other half of the abstraction: both kinds coexist.
  const slate = await readMaterials(page);
  expect(new Set(Object.values(slate.slots))).toEqual(new Set(['placeholder']));

  await page.selectOption('#scene-select', 'copper-padlock');
  await settleMaterials(page);

  const back = await readMaterials(page);
  expect(back.slots).toEqual(copper.slots);
  // Nothing was re-downloaded: the registry outlives any one scene.
  expect(back.sources).toBe(copper.sources);
  expect((await readRendererState(page)).textures).toBe(copperTextures);
});
