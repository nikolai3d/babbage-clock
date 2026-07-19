import { expect, test } from '@playwright/test';
import {
  SELECTOR,
  deterministicOptions,
  gotoApp,
  readRendererState,
  watchConsole,
} from './support/app.js';

/**
 * The compressed environment path, driven through the real app.
 *
 * The unit suite proves the wiring — which transcoder path a `.ktx2` panorama
 * is routed through, what happens when a load fails or teardown races it — but
 * mocks the transcoder itself, because it is wasm in a Worker. The shipped
 * moods are all `.hdr`, so without this spec nothing in CI ever runs the real
 * Basis transcoder against a real UASTC-HDR container end to end: fetch,
 * transcode, PMREM prefilter, atomic mood commit.
 *
 * The fixture is `assets/ibl/test-uastc-hdr/` — a 1.3 kB genuine UASTC-HDR
 * sample from three.js r182, reachable only through the `?moodOverride=` test
 * hook because the picker (and `?mood=`) deliberately excludes `test-`
 * folders. Assertions are about state and the network log, not pixels: the
 * fixture mood is asserted on, never looked at, so no screenshot baseline is
 * involved.
 */

test('the KTX2/UASTC-HDR environment path decodes and commits in a real browser', async ({
  page,
}) => {
  const console_ = watchConsole(page);

  // Installed before navigation so the boot-time fetches are all seen. The
  // transcoder's js and wasm are loaded on the main thread by KTX2Loader and
  // handed to its worker, so both requests are visible from here.
  const requested: string[] = [];
  page.on('request', (request) => requested.push(request.url()));

  await gotoApp(page, deterministicOptions({ moodOverride: 'test-uastc-hdr' }));

  // `gotoApp` has already waited the mood out of 'loading', so this is the
  // settled state: 'ready' with the fixture committed, or the test fails now
  // with the state it actually reached. `mood` matters as much as 'ready' — a
  // mis-wired override would fall back to the scene's default `.hdr` mood and
  // still read 'ready'.
  const state = await readRendererState(page);
  expect(state.lighting).toBe('ready');
  expect(state.mood).toBe('test-uastc-hdr');
  // The commit did not stall the renderer: the scene is still being drawn.
  expect(state.drawCalls).toBeGreaterThan(0);

  // The fixture actually travelled: the container is small enough that Vite
  // inlines it as a data URI inside its lazy chunk (the stem survives in the
  // chunk name), so this matches that chunk in a preview/CI build — and the
  // raw file path when run against a dev server. Either way, no request means
  // the override never reached the fixture.
  expect(requested.filter((url) => url.includes('uastc_hdr'))).not.toEqual([]);

  // A genuine UASTC-HDR file needs the Basis wasm transcoder on any GPU
  // without native ASTC-HDR — which includes CI's SwiftShader, where this
  // assertion is the point of the spec. A GPU with native support (some
  // Apple-silicon stacks) legitimately skips the transcoder for the same
  // file, so the assertion is gated rather than dropped to keep the spec
  // honest on developer machines.
  const astcHdrNative = await page.evaluate(() => {
    const gl = document.createElement('canvas').getContext('webgl2');
    const ext = gl?.getExtension('WEBGL_compressed_texture_astc') as {
      getSupportedProfiles(): string[];
    } | null;
    return ext !== null && ext !== undefined && ext.getSupportedProfiles().includes('hdr');
  });
  if (!astcHdrNative) {
    const transcoder = requested.filter((url) => url.includes('basis_transcoder'));
    expect(transcoder.some((url) => url.endsWith('basis_transcoder.js'))).toBe(true);
    expect(transcoder.some((url) => url.endsWith('basis_transcoder.wasm'))).toBe(true);
  }

  // The error path was never taken: no application errors, every own-origin
  // asset served, and the environment controller never fell back to keeping a
  // previous mood.
  expect(console_.errors).toEqual([]);
  expect(console_.failedRequests).toEqual([]);
  expect(console_.messages.filter((text) => text.includes('could not be applied'))).toEqual([]);

  // The fixture is a CI vehicle, not a shipped mood: the picker must not offer
  // it. The guard on a real mood proves the option list was actually read —
  // an empty read would pass the negative assertion vacuously.
  const offered = await page
    .locator(`${SELECTOR.moodSelect} option`)
    .evaluateAll((options) => options.map((option) => (option as HTMLOptionElement).value));
  expect(offered).toContain('steampunk-workshop');
  expect(offered).not.toContain('test-uastc-hdr');
});
