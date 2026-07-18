/**
 * Settings shared by the e2e config and the demo-capture config.
 *
 * Kept in one module so a screenshot baseline can never be produced under
 * different browser flags or context settings from the ones that verify it.
 */

export const E2E_PORT = Number(process.env.E2E_PORT ?? 4173);

/**
 * The preview server's bind address.
 *
 * Pinned to IPv4 rather than left as `localhost`: `vite preview` binds to
 * `localhost` only, which resolves to `::1` first on macOS, so a `127.0.0.1`
 * probe never connects and Playwright's `webServer` wait times out. Passing the
 * host explicitly on both sides removes the ambiguity.
 */
export const E2E_HOST = '127.0.0.1';
export const E2E_BASE_URL = `http://${E2E_HOST}:${E2E_PORT}`;

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
