/**
 * Settings shared by the e2e config and the demo-capture config.
 *
 * Kept in one module so a screenshot baseline can never be produced under
 * different browser flags or context settings from the ones that verify it.
 */

/**
 * The preview server's port.
 *
 * `E2E_PORT` wins when set. Otherwise CI takes the fixed default — one suite per
 * job, so a stable port keeps logs and failures predictable.
 *
 * Outside CI the default is per-process, and that is a correctness fix rather
 * than a convenience. `webServer.reuseExistingServer` is on outside CI, so two
 * runs sharing a port do not collide: the second one quietly *attaches to the
 * first one's server* and tests the first one's build. Wrong code, green result,
 * no error anywhere. Several agents or worktrees driving this repo at once is
 * normal here, so the port has to be theirs alone by default.
 */
function resolvePort(): number {
  const explicit = process.env.E2E_PORT;
  if (explicit) return Number(explicit);
  if (process.env.CI) return 4173;
  return 4174 + (process.pid % 500);
}

const port = resolvePort();

// Pinned into the environment so Playwright's worker processes — which re-import
// this module rather than inheriting its evaluated state — resolve the same port
// as the run that started the server.
process.env.E2E_PORT = String(port);

export const E2E_PORT = port;

/**
 * The preview server's bind address.
 *
 * Pinned to IPv4 rather than left as `localhost`: `vite preview` binds to
 * `localhost` only, which resolves to `::1` first on macOS, so a `127.0.0.1`
 * probe never connects and Playwright's `webServer` wait times out. Passing the
 * host explicitly on both sides removes the ambiguity.
 */
export const E2E_HOST = '127.0.0.1';

/** The local preview server the hermetic suite drives. */
export const E2E_LOCAL_BASE_URL = `http://${E2E_HOST}:${E2E_PORT}/`;

/**
 * The origin (and base path) under test.
 *
 * Defaults to the local preview server. `E2E_BASE_URL` overrides it so the
 * same specs can be pointed at a deployed site — that is how the post-deploy
 * smoke job proves the published bundle boots. See `playwright.smoke.config.ts`.
 *
 * The trailing slash is not cosmetic. Playwright resolves a spec's path against
 * this with `new URL()`, and the deployed site lives under a base path
 * (`https://nikolai3d.github.io/babbage-clock/`). Without the slash the last
 * segment is treated as a file name and dropped, so every request would land on
 * the wrong path. {@link appUrl} pairs with this by emitting `./`-relative
 * paths rather than root-absolute ones.
 */
export const E2E_BASE_URL = withTrailingSlash(process.env.E2E_BASE_URL ?? E2E_LOCAL_BASE_URL);

function withTrailingSlash(url: string): string {
  return url.endsWith('/') ? url : `${url}/`;
}

/** The command both configs use to serve the production bundle under test. */
export const E2E_SERVER_COMMAND = `npm run build && npm run preview -- --port ${E2E_PORT} --strictPort --host ${E2E_HOST}`;

/**
 * Force ANGLE's SwiftShader backend.
 *
 * Headless Chromium has no GPU on a CI runner, and without these flags it
 * refuses to hand out a WebGL2 context at all — the app then logs
 * "WebGL2 unavailable" and renders an empty canvas. `--enable-unsafe-swiftshader`
 * is required from Chromium 120 onward, which stopped allowing the SwiftShader
 * fallback for WebGL implicitly.
 *
 * These are applied on developer machines too. A real GPU would otherwise
 * produce frames that CI can never reproduce, which is exactly the baseline
 * churn this suite is meant to avoid.
 */
export const CHROMIUM_GPU_ARGS = [
  '--use-gl=angle',
  '--use-angle=swiftshader',
  '--enable-unsafe-swiftshader',
  '--hide-scrollbars',
  '--mute-audio',
];

/**
 * Context settings that remove ambient variation from a frame.
 *
 * `timezoneId` and `locale` matter more than they look: the HUD renders the
 * target label with `toLocaleString()`, and the default countdown target is
 * "next New Year in the viewer's timezone". Both would otherwise change the
 * rendered text depending on where the machine is.
 */
export const DETERMINISTIC_CONTEXT = {
  viewport: { width: 1280, height: 720 },
  deviceScaleFactor: 1,
  locale: 'en-US',
  timezoneId: 'UTC',
  colorScheme: 'dark',
} as const;

/**
 * A portrait phone, for the mobile project.
 *
 * Pixel 7's CSS viewport, which is within a few pixels of every current phone
 * that matters (Pixel 7 412x915, iPhone 15 393x852, Galaxy S23 360x780) and
 * gives the same 0.45 aspect ratio the framing has to cope with.
 *
 * `deviceScaleFactor` is pinned to 1 rather than the device's real 2.625, for
 * the same reason the desktop context pins it: a baseline is compared pixel for
 * pixel, and a 2.625x image is seven times the pixels to rasterise, diff and
 * store. What the tier does with a high device pixel ratio is a unit test
 * (`src/app/quality.test.ts`) — it needs no browser.
 *
 * `isMobile` brings the mobile viewport meta handling and `hasTouch` the touch
 * event model, which are the parts the responsive shell actually depends on.
 */
export const MOBILE_PORTRAIT_CONTEXT = {
  viewport: { width: 412, height: 915 },
  deviceScaleFactor: 1,
  isMobile: true,
  hasTouch: true,
  locale: 'en-US',
  timezoneId: 'UTC',
  colorScheme: 'dark',
} as const;
