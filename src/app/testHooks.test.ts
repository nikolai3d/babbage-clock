import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_TEST_HOOKS,
  createMockTimeSource,
  installTestApi,
  parseMockNow,
  presentationTimeStatus,
  readTestHooks,
  resolveTimeSource,
} from './testHooks.js';
import type {
  ClockTestApi,
  MaterialState,
  RendererState,
  StoreProbe,
  TestHooks,
} from './testHooks.js';
import type { TimeSource } from '../time/target.js';
import type { MechanismEvent } from '../mechanism/index.js';

const EPOCH = Date.UTC(2026, 0, 1, 0, 0, 0);

describe('readTestHooks', () => {
  it('is completely inert without query parameters', () => {
    expect(readTestHooks('')).toEqual(DEFAULT_TEST_HOOKS);
    expect(readTestHooks('?scene=slate-orrery&target=2027-01-01')).toEqual(DEFAULT_TEST_HOOKS);
  });

  it('reads a pinned clock from epoch milliseconds or an ISO instant', () => {
    expect(readTestHooks(`?mockNow=${EPOCH}`).mockNowMs).toBe(EPOCH);
    expect(readTestHooks('?mockNow=2026-01-01T00:00:00Z').mockNowMs).toBe(EPOCH);
  });

  it('defaults a pinned clock to frozen and honours advance', () => {
    expect(readTestHooks(`?mockNow=${EPOCH}`).mockNowMode).toBe('frozen');
    expect(readTestHooks(`?mockNow=${EPOCH}&mockNowMode=advance`).mockNowMode).toBe('advance');
    expect(readTestHooks(`?mockNow=${EPOCH}&mockNowMode=frozen`).mockNowMode).toBe('frozen');
  });

  it('ignores an unparseable mockNow rather than crashing the app', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    expect(readTestHooks('?mockNow=not-a-time').mockNowMs).toBeNull();
    expect(warn).toHaveBeenCalledOnce();

    warn.mockRestore();
  });

  it('treats a bare flag as on and an explicit negation as off', () => {
    expect(readTestHooks('?nomotion').motion).toBe(false);
    expect(readTestHooks('?nomotion=1').motion).toBe(false);
    expect(readTestHooks('?nomotion=true').motion).toBe(false);
    expect(readTestHooks('?nomotion=0').motion).toBe(true);
    expect(readTestHooks('?nomotion=false').motion).toBe(true);
    expect(readTestHooks('?nosync').timeSync).toBe(false);
    expect(readTestHooks('?nosync=1').timeSync).toBe(false);
    expect(readTestHooks('?nosync=0').timeSync).toBe(true);
    expect(readTestHooks('?testApi=1').testApi).toBe(true);
    expect(readTestHooks('?testApi=0').testApi).toBe(false);
  });

  it('leaves every other hook alone when one is set', () => {
    // Regression guard: the hooks must stay orthogonal, so a spec can opt into
    // exactly one behaviour without silently getting the others.
    expect(readTestHooks('?nosync=1')).toEqual({ ...DEFAULT_TEST_HOOKS, timeSync: false });
    expect(readTestHooks('?nomotion=1')).toEqual({ ...DEFAULT_TEST_HOOKS, motion: false });
    expect(readTestHooks('?testApi=1')).toEqual({ ...DEFAULT_TEST_HOOKS, testApi: true });
    expect(readTestHooks('?moodOverride=test-uastc-hdr')).toEqual({
      ...DEFAULT_TEST_HOOKS,
      moodOverride: 'test-uastc-hdr',
    });
  });

  it('passes a mood override through raw, and treats an empty one as absent', () => {
    // The value is deliberately unvalidated — it names preset folders the
    // picker whitelist excludes on purpose, so there is no list to check
    // against. Whitespace and emptiness are authoring slips, not ids.
    expect(readTestHooks('?moodOverride=test-uastc-hdr').moodOverride).toBe('test-uastc-hdr');
    expect(readTestHooks('?moodOverride=%20test-x%20').moodOverride).toBe('test-x');
    expect(readTestHooks('?moodOverride=').moodOverride).toBeNull();
    expect(readTestHooks('?moodOverride=%20%20').moodOverride).toBeNull();
    expect(readTestHooks('').moodOverride).toBeNull();
  });
});

describe('parseMockNow', () => {
  it('treats a digits-only value as epoch milliseconds, not a year', () => {
    // `new Date('2026')` is a valid year parse; that must not win here.
    expect(parseMockNow('2026')).toBe(2026);
    expect(parseMockNow('0')).toBe(0);
    expect(parseMockNow('-1000')).toBe(-1000);
  });

  it('returns null for missing or unparseable values', () => {
    expect(parseMockNow(null)).toBeNull();
    expect(parseMockNow(undefined)).toBeNull();
    expect(parseMockNow('   ')).toBeNull();
    expect(parseMockNow('tomorrow-ish')).toBeNull();
  });
});

describe('createMockTimeSource', () => {
  it('frozen mode returns the same instant no matter how time passes', () => {
    let clock = 0;
    const source = createMockTimeSource(EPOCH, 'frozen', () => clock);

    expect(source.now()).toBe(EPOCH);
    clock = 5_000;
    expect(source.now()).toBe(EPOCH);
  });

  it('advance mode starts pinned and then tracks monotonic time', () => {
    let clock = 1_000;
    const source = createMockTimeSource(EPOCH, 'advance', () => clock);

    expect(source.now()).toBe(EPOCH);
    clock = 3_500;
    expect(source.now()).toBe(EPOCH + 2_500);
  });
});

describe('resolveTimeSource', () => {
  const fallback: TimeSource = { now: () => 123 };

  it('returns the real source untouched when no clock is pinned', () => {
    expect(resolveTimeSource(DEFAULT_TEST_HOOKS, fallback)).toBe(fallback);
  });

  it('substitutes a pinned adapter when mockNow is set', () => {
    const hooks: TestHooks = { ...DEFAULT_TEST_HOOKS, mockNowMs: EPOCH };

    const resolved = resolveTimeSource(hooks, fallback);

    expect(resolved).not.toBe(fallback);
    expect(resolved.now()).toBe(EPOCH);
  });
});

describe('advance-mode integrality', () => {
  it('returns integral epochs even from a fractional monotonic source', () => {
    // Temporal rejects fractional epochs; the real clock floors at source and
    // the mock must too, or advance-mode tests crash any Temporal caller.
    const clock = createMockTimeSource(1_000, 'advance', () => 0.4142 + 16.6667);
    expect(Number.isInteger(clock.now())).toBe(true);
  });
});

describe('mocksync', () => {
  it('is off by default and off when negated', () => {
    expect(readTestHooks('').mockSync).toBe(false);
    expect(readTestHooks('?mocksync=0').mockSync).toBe(false);
  });

  it('is on with ?mocksync and ?mocksync=1', () => {
    expect(readTestHooks('?mocksync').mockSync).toBe(true);
    expect(readTestHooks('?mocksync=1').mockSync).toBe(true);
  });

  it('presents a healthy synced status, dated to the pinned clock', () => {
    const status = presentationTimeStatus(1_750_000_000_000);
    expect(status.synced).toBe(true);
    expect(status.degraded).toBe(false);
    expect(status.skewWarning).toBe(false);
    expect(status.tier).toBe('ntp-lite');
    expect(status.lastSyncMs).toBe(1_750_000_000_000);
  });
});

describe('installTestApi', () => {
  const rendererState: RendererState = {
    webgl2: true,
    frames: 42,
    fps: 60,
    running: true,
    drawCalls: 17,
    triangles: 1234,
    textures: 9,
    geometries: 12,
    width: 800,
    height: 600,
    pixelRatio: 1,
    motion: false,
    contextLost: false,
    cameraPosition: [0, 0, 6],
    sceneId: 'copper-padlock',
    lighting: 'ready',
    mood: 'steampunk-workshop',
    quality: 'high',
    maxFps: null,
    framingFit: 'whole',
    ringExtentPx: 420,
    panoramaBackground: true,
  };

  const materialState: MaterialState = {
    look: null,
    slots: { housing: 'pbr:copper-plate', numerals: 'placeholder' },
    textures: 3,
    sources: 3,
    pending: 0,
    ktx2: false,
  };

  /** A canned seek, for asserting the facade hands back the probe's own object. */
  const seekEvent: MechanismEvent = {
    kind: 'seek',
    atMs: 1000,
    durationMs: 420,
    digits: [0, 2, 1],
    previousDigits: [0, 1, 0],
    motions: [{ ring: 1, fromDigit: 1, toDigit: 2, steps: 1, deltaAngle: -0.62 }],
    carryDepth: 0,
    expired: false,
  };

  function deps(): {
    store: StoreProbe;
    renderer: {
      getDigits: () => number[];
      getRingAngles: () => number[];
      getLastMechanismEvent: () => MechanismEvent | null;
      getRenderState: () => RendererState;
      getMaterialState: () => MaterialState;
    };
    timeSource: TimeSource;
  } {
    return {
      store: {
        get: () => ({
          sceneId: 'copper-padlock',
          target: { label: 'New Year 2027', atMs: EPOCH, source: 'default-new-year' as const },
          countdown: {
            totalMs: 1000,
            elapsed: false,
            days: 0,
            hours: 0,
            minutes: 0,
            seconds: 1,
            milliseconds: 0,
          },
          remaining: {
            totalSeconds: 1,
            rawTotalSeconds: 1,
            hours: 0,
            minutes: 0,
            seconds: 1,
            clamped: false,
            expired: false,
          },
          hidden: false,
          fps: 60,
        }),
      },
      renderer: {
        getDigits: () => [1, 2, 3],
        getRingAngles: () => [0.1, 0.2, 0.3],
        getLastMechanismEvent: () => null,
        getRenderState: () => rendererState,
        getMaterialState: () => materialState,
      },
      timeSource: { now: () => EPOCH },
    };
  }

  it('installs nothing without ?testApi', () => {
    const host: { __clock?: ClockTestApi } = {};

    const dispose = installTestApi(DEFAULT_TEST_HOOKS, deps(), host);

    expect(host.__clock).toBeUndefined();
    expect(Object.hasOwn(host, '__clock')).toBe(false);
    dispose();
    expect(host.__clock).toBeUndefined();
  });

  it('exposes live digits, scene and renderer state when enabled', () => {
    const host: { __clock?: ClockTestApi } = {};
    const hooks: TestHooks = { ...DEFAULT_TEST_HOOKS, testApi: true };

    const source = deps();
    source.renderer.getLastMechanismEvent = () => seekEvent;
    installTestApi(hooks, source, host);

    const api = host.__clock;
    expect(api).toBeDefined();
    expect(api?.version).toBe(1);
    expect(api?.digits()).toEqual([1, 2, 3]);
    expect(api?.ringAngles()).toEqual([0.1, 0.2, 0.3]);
    // Identity, not shape: the facade must hand back the mechanism's own
    // event object, never a copy — the e2e collector dedups by identity.
    expect(api?.lastMechanismEvent()).toBe(seekEvent);
    expect(api?.sceneId()).toBe('copper-padlock');
    expect(api?.renderer().webgl2).toBe(true);
    expect(api?.renderer().drawCalls).toBe(17);
    // `mood` reaches the test API intact: `e2e/ibl.spec.ts` reads it to tell
    // the fixture apart from a fallback to the scene's own mood, and proving
    // the passthrough here costs microseconds instead of a browser boot.
    expect(api?.renderer().mood).toBe('steampunk-workshop');
    expect(api?.materials().slots['housing']).toBe('pbr:copper-plate');
    expect(api?.countdown().seconds).toBe(1);
    expect(api?.target().label).toBe('New Year 2027');
    expect(api?.hooks()).toEqual(hooks);
    expect(api?.now()).toBe(EPOCH);
  });

  it('disposer removes the API, but only its own instance', () => {
    const host: { __clock?: ClockTestApi } = {};
    const hooks: TestHooks = { ...DEFAULT_TEST_HOOKS, testApi: true };

    const disposeFirst = installTestApi(hooks, deps(), host);
    const first = host.__clock;

    // A hot reload installs the replacement before the old disposer runs.
    installTestApi(hooks, deps(), host);
    const second = host.__clock;
    expect(second).not.toBe(first);

    disposeFirst();

    expect(host.__clock).toBe(second);
  });
});
