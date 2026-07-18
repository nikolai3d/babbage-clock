/**
 * Test-mode hooks: a small, explicitly gated surface that makes the app
 * observable and reproducible for end-to-end tests, screenshots and demo
 * capture.
 *
 * Two rules govern everything in this module:
 *
 * 1. **No query parameter, no effect.** Every hook is off unless its parameter
 *    is present, so production behaviour is byte-for-byte what it was before
 *    this module existed. `readTestHooks('')` returns {@link DEFAULT_TEST_HOOKS},
 *    which resolves to the system clock, motion enabled, and no global test API.
 * 2. **No new coupling.** The clock hook is an adapter satisfying the existing
 *    `TimeSource` interface from `time/target.ts`, and the renderer is consumed
 *    through the structural {@link RendererProbe} interface. `src/time/` and
 *    `src/render/` do not import this module.
 */

import type { CountdownParts } from '../time/countdown.js';
import type { CountdownTarget, TimeSource } from '../time/target.js';

/** Canonical test-hook query-parameter names, kept beside the app's own. */
export const TEST_URL_PARAM = {
  /** Epoch milliseconds (or an ISO 8601 string) to pin the clock to. */
  mockNow: 'mockNow',
  /** `frozen` (default) or `advance`. */
  mockNowMode: 'mockNowMode',
  /** Disables idle drift, gear rotation and easing. */
  noMotion: 'nomotion',
  /** Skips the network clock correction. */
  noSync: 'nosync',
  /** Installs `window.__clock`. */
  testApi: 'testApi',
} as const;

/**
 * How a pinned clock behaves after start-up.
 *
 * - `frozen`: `now()` always returns the pinned instant. Used for screenshots,
 *   where every frame must be identical.
 * - `advance`: `now()` starts at the pinned instant and then advances with real
 *   monotonic time. Used for the demo capture and for tick assertions, which
 *   need genuine animation from a known starting point.
 */
export type MockNowMode = 'frozen' | 'advance';

export interface TestHooks {
  /** Pinned start instant in epoch milliseconds, or `null` for the real clock. */
  readonly mockNowMs: number | null;
  readonly mockNowMode: MockNowMode;
  /** `false` only when `?nomotion` is set. Motion is on by default. */
  readonly motion: boolean;
  /**
   * `false` only when `?nosync` is set. Network clock correction is on by
   * default.
   *
   * Tests turn it off so the suite is hermetic: the correction fires several
   * probe requests per page load, which is both an external dependency and,
   * against a single local preview server under parallel workers, enough
   * contention to starve the page's own module loads.
   */
  readonly timeSync: boolean;
  /** Whether `window.__clock` should be installed. */
  readonly testApi: boolean;
}

export const DEFAULT_TEST_HOOKS: TestHooks = {
  mockNowMs: null,
  mockNowMode: 'frozen',
  motion: true,
  timeSync: true,
  testApi: false,
};

/**
 * A flag is on when its parameter is present and not explicitly negated, so
 * both `?nomotion` and `?nomotion=1` work while `?nomotion=0` stays off.
 */
function readFlag(params: URLSearchParams, name: string): boolean {
  const raw = params.get(name);
  if (raw === null) return false;
  const value = raw.trim().toLowerCase();
  return value !== '0' && value !== 'false' && value !== 'off';
}

/**
 * Parses a pinned instant. Accepts epoch milliseconds (`1767225600000`) or
 * anything `Date` understands (`2026-01-01T00:00:00Z`), because hand-written
 * test URLs are far easier to read in ISO form.
 */
export function parseMockNow(raw: string | null | undefined): number | null {
  if (raw === null || raw === undefined) return null;
  const trimmed = raw.trim();
  if (trimmed === '') return null;

  // Digits-only is unambiguous epoch milliseconds. Passing such a string to
  // `Date` would parse it as a *year*, which is never what a caller means here.
  if (/^-?\d+$/.test(trimmed)) {
    const epoch = Number(trimmed);
    return Number.isFinite(epoch) ? epoch : null;
  }

  const parsed = Date.parse(trimmed);
  return Number.isNaN(parsed) ? null : parsed;
}

function parseMockNowMode(raw: string | null): MockNowMode {
  return raw !== null && raw.trim().toLowerCase() === 'advance' ? 'advance' : 'frozen';
}

/** Reads every test hook out of a query string. Never throws. */
export function readTestHooks(search: string): TestHooks {
  const params = new URLSearchParams(search);
  const mockNowRaw = params.get(TEST_URL_PARAM.mockNow);
  const mockNowMs = parseMockNow(mockNowRaw);

  if (mockNowRaw !== null && mockNowMs === null) {
    console.warn(`[testHooks] Ignoring unparseable ?${TEST_URL_PARAM.mockNow}=${mockNowRaw}`);
  }

  return {
    mockNowMs,
    mockNowMode: parseMockNowMode(params.get(TEST_URL_PARAM.mockNowMode)),
    motion: !readFlag(params, TEST_URL_PARAM.noMotion),
    timeSync: !readFlag(params, TEST_URL_PARAM.noSync),
    testApi: readFlag(params, TEST_URL_PARAM.testApi),
  };
}

/**
 * A `TimeSource` pinned to `startMs`.
 *
 * `monotonic` is injected so this is unit-testable without a DOM; it defaults
 * to `performance.now()`, which — unlike `Date.now()` — cannot jump backwards
 * if the host clock is adjusted mid-capture.
 */
export function createMockTimeSource(
  startMs: number,
  mode: MockNowMode,
  monotonic: () => number = () => performance.now(),
): TimeSource {
  if (mode === 'frozen') return { now: () => startMs };

  const origin = monotonic();
  return { now: () => startMs + (monotonic() - origin) };
}

/**
 * The effective clock: a pinned adapter when `?mockNow=` is present, otherwise
 * the caller's real source, returned untouched.
 */
export function resolveTimeSource(
  hooks: TestHooks,
  fallback: TimeSource,
  monotonic?: () => number,
): TimeSource {
  if (hooks.mockNowMs === null) return fallback;
  return createMockTimeSource(hooks.mockNowMs, hooks.mockNowMode, monotonic);
}

/** Renderer state surfaced to e2e tests so they assert on state, not pixels. */
export interface RendererState {
  /** False if the context fell back to WebGL1 — the CI SwiftShader canary. */
  readonly webgl2: boolean;
  /** Frames drawn since start-up; a still-advancing loop is a live scene. */
  readonly frames: number;
  readonly fps: number;
  /** True while the requestAnimationFrame loop is scheduled. */
  readonly running: boolean;
  /** Draw calls in the last frame. Zero means an empty scene was presented. */
  readonly drawCalls: number;
  readonly triangles: number;
  /**
   * Live GPU textures, read from `renderer.info.memory`.
   *
   * The leak canary for the material pipeline: swapping looks back and forth
   * must return this to where it started, or something is holding a reference
   * it should have given back.
   */
  readonly textures: number;
  /** Live GPU geometries, likewise. */
  readonly geometries: number;
  readonly width: number;
  readonly height: number;
  readonly pixelRatio: number;
  /**
   * The *effective* motion setting: false when drift, rotation and easing are
   * off, whether that came from `?nomotion` or from the viewer's
   * `prefers-reduced-motion`. `hooks().motion` reports only the parameter, so
   * comparing the two is how a spec tells the media query apart from the URL.
   */
  readonly motion: boolean;
  /** True while the WebGL context is gone and the text fallback is showing. */
  readonly contextLost: boolean;
  /**
   * Camera position in world space. Surfaced so a spec can prove the keyboard
   * orbit alternative actually moves the view, rather than photographing it.
   */
  readonly cameraPosition: readonly [number, number, number];
  readonly sceneId: string | null;
  /**
   * The lighting mood's state: `loading` while its HDR environment map is on
   * its way, `ready` once it is applied, `none` when the scene asks for no
   * environment, `error` when the map could not be loaded.
   *
   * A frame photographed while this is `loading` shows the previous mood, so a
   * screenshot must wait for it to settle. Spelled out as a literal union
   * rather than imported from `render/lighting.ts` to keep this module free of
   * three.js-adjacent imports.
   */
  readonly lighting: 'none' | 'loading' | 'ready' | 'error';
  /** The render-quality tier in force. See `app/quality.ts`. */
  readonly quality: 'high' | 'low';
  /** Frame ceiling the tier imposes, or null when the loop runs free. */
  readonly maxFps: number | null;
  /**
   * `whole` when the entire mechanism is in frame, `rings` when the aspect
   * ratio forced a crop to the digit rings. See `scene/framing.ts`.
   */
  readonly framingFit: 'whole' | 'rings';
  /**
   * On-screen width of the ring stack's bounding extent, in CSS pixels.
   *
   * The mobile project asserts on this: "the reading is legible without
   * interaction" is a claim about how big the drums are and whether all of them
   * are on screen, and this is that claim as a number. It is the bounding
   * sphere's diameter, so it slightly overstates the drums themselves.
   */
  readonly ringExtentPx: number;
}

/** What the material pipeline is currently doing. */
export interface MaterialState {
  /** Active look id, or null when the scene's own materials are in force. */
  readonly look: string | null;
  /** Slot -> `pbr:<material-id>` or `placeholder`. */
  readonly slots: Record<string, string>;
  /** Texture instances the registry has handed out and not had back. */
  readonly textures: number;
  /** Distinct image files decoded and cached. */
  readonly sources: number;
  /** Loads still in flight. */
  readonly pending: number;
  /** True when a KTX2 transcoder was found and compressed maps are preferred. */
  readonly ktx2: boolean;
}

/**
 * The slice of the renderer the test API needs.
 *
 * Structural on purpose: `ClockRenderer` satisfies it without importing this
 * module, so nothing in `src/render/` depends on test-only code.
 */
export interface RendererProbe {
  getDigits(): readonly number[];
  getRenderState(): RendererState;
  getMaterialState(): MaterialState;
}

/** The slice of the store the test API needs. */
export interface StoreProbe {
  get(): {
    readonly sceneId: string;
    readonly target: CountdownTarget;
    readonly countdown: CountdownParts;
    readonly hidden: boolean;
    readonly fps: number;
  };
}

/**
 * `window.__clock` — the read-only observation surface for e2e specs.
 *
 * Methods rather than a snapshot object: a spec polls these while the render
 * loop runs, so every call must read live state.
 */
export interface ClockTestApi {
  /** Bumped when a field changes meaning, so specs can fail loudly. */
  readonly version: 1;
  /** The digits the rings are currently displaying, most significant first. */
  digits(): readonly number[];
  sceneId(): string;
  countdown(): CountdownParts;
  target(): CountdownTarget;
  renderer(): RendererState;
  /** Material bindings, look and texture accounting. */
  materials(): MaterialState;
  /** The hooks in force, echoed back for diagnostics. */
  hooks(): TestHooks;
  /** The effective clock reading, via the same source the renderer uses. */
  now(): number;
}

declare global {
  interface Window {
    __clock?: ClockTestApi;
  }
}

export interface TestApiDependencies {
  readonly store: StoreProbe;
  readonly renderer: RendererProbe;
  readonly timeSource: TimeSource;
}

/** Install target, overridable so this is testable outside a browser. */
type TestApiHost = { __clock?: ClockTestApi };

/**
 * Installs `window.__clock` when `?testApi` is set, and does nothing at all
 * otherwise. Returns a disposer that removes it again.
 */
export function installTestApi(
  hooks: TestHooks,
  deps: TestApiDependencies,
  host: TestApiHost = globalThis as TestApiHost,
): () => void {
  if (!hooks.testApi) return () => undefined;

  const { store, renderer, timeSource } = deps;
  const api: ClockTestApi = {
    version: 1,
    digits: () => renderer.getDigits(),
    sceneId: () => store.get().sceneId,
    countdown: () => store.get().countdown,
    target: () => store.get().target,
    renderer: () => renderer.getRenderState(),
    materials: () => renderer.getMaterialState(),
    hooks: () => hooks,
    now: () => timeSource.now(),
  };

  host.__clock = api;
  return () => {
    // Only retract our own instance: an HMR reload installs the replacement
    // before the outgoing module's disposer runs.
    if (host.__clock === api) delete host.__clock;
  };
}
