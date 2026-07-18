import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_TEST_HOOKS,
  createMockTimeSource,
  installTestApi,
  parseMockNow,
  readTestHooks,
  resolveTimeSource,
} from './testHooks.js';
import type { ClockTestApi, RendererState, StoreProbe, TestHooks } from './testHooks.js';
import type { TimeSource } from '../time/target.js';

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

describe('installTestApi', () => {
  const rendererState: RendererState = {
    webgl2: true,
    frames: 42,
    fps: 60,
    running: true,
    drawCalls: 17,
    triangles: 1234,
    width: 800,
    height: 600,
    pixelRatio: 1,
    motion: false,
    contextLost: false,
    cameraPosition: [0, 0, 6],
    sceneId: 'copper-padlock',
    lighting: 'ready',
  };

  function deps(): {
    store: StoreProbe;
    renderer: { getDigits: () => number[]; getRenderState: () => RendererState };
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
          hidden: false,
          fps: 60,
        }),
      },
      renderer: { getDigits: () => [1, 2, 3], getRenderState: () => rendererState },
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

    installTestApi(hooks, deps(), host);

    const api = host.__clock;
    expect(api).toBeDefined();
    expect(api?.version).toBe(1);
    expect(api?.digits()).toEqual([1, 2, 3]);
    expect(api?.sceneId()).toBe('copper-padlock');
    expect(api?.renderer().webgl2).toBe(true);
    expect(api?.renderer().drawCalls).toBe(17);
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
