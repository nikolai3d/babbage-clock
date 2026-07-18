import { describe, expect, it } from 'vitest';
import {
  TrueTimeClock,
  disposeTrueTime,
  estimateOffset,
  getRemaining,
  getTrueTimeClock,
} from './trueTime.js';
import type { Scheduler, TrueTimeOptions, VisibilitySource } from './trueTime.js';
import type { TimeProvider } from './providers.js';

/**
 * A controllable world: monotonic time only advances when a test says so, the
 * device clock can be shoved around mid-session, and no request leaves the
 * process. Nothing in this file may touch the network or a real timer.
 */
class FakeWorld {
  monotonicMs = 1_000;
  deviceMs = Date.UTC(2026, 6, 1, 12, 0, 0);
  /** Corrected epoch the fake servers believe in. */
  serverMs = Date.UTC(2026, 6, 1, 12, 0, 0);

  readonly intervals = new Map<number, { handler: () => void; ms: number }>();
  readonly timeouts = new Map<number, { handler: () => void; ms: number }>();
  private nextHandle = 1;

  readonly monotonic = (): number => this.monotonicMs;
  readonly deviceNow = (): number => this.deviceMs;

  /** Ordinary passage of time: every clock moves together. */
  advance(ms: number): void {
    this.monotonicMs += ms;
    this.deviceMs += ms;
    this.serverMs += ms;
  }

  /** The OS clock is dragged, leaving monotonic time untouched. */
  skewDevice(ms: number): void {
    this.deviceMs += ms;
  }

  /** The world turns out to be ahead of (or behind) what the device believes. */
  skewServer(ms: number): void {
    this.serverMs += ms;
  }

  get scheduler(): Scheduler {
    return {
      setInterval: (handler, ms) => {
        const handle = this.nextHandle++;
        this.intervals.set(handle, { handler, ms });
        return handle;
      },
      clearInterval: (handle) => {
        this.intervals.delete(handle);
      },
      setTimeout: (handler, ms) => {
        const handle = this.nextHandle++;
        this.timeouts.set(handle, { handler, ms });
        return handle;
      },
      clearTimeout: (handle) => {
        this.timeouts.delete(handle);
      },
    };
  }

  /** Fires every registered interval once, as a background re-sync would. */
  fireIntervals(): void {
    for (const { handler } of [...this.intervals.values()]) handler();
  }
}

interface FakeProviderOptions {
  readonly id?: string;
  readonly tier?: TimeProvider['tier'];
  readonly resolutionMs?: number;
  /** Simulated round-trip latency per call, cycled. */
  readonly latencies?: readonly number[];
  /** Constant error added to the server's answer, in ms. */
  readonly serverErrorMs?: number;
  /** Calls that should reject instead of answering (0-based indices). */
  readonly failAt?: readonly number[];
  /** Reject every call. */
  readonly alwaysFail?: boolean;
}

function fakeProvider(
  world: FakeWorld,
  options: FakeProviderOptions = {},
): TimeProvider & { calls: number } {
  const latencies = options.latencies ?? [40];
  const provider = {
    id: options.id ?? 'fake',
    tier: options.tier ?? ('ntp-lite' as const),
    resolutionMs: options.resolutionMs ?? 1,
    calls: 0,
    fetchServerTime: (_signal: AbortSignal): Promise<number> => {
      const index = provider.calls;
      provider.calls += 1;

      if (options.alwaysFail === true || options.failAt?.includes(index) === true) {
        // Latency is still spent on a failing request, as it would be in life.
        world.advance(latencies[index % latencies.length] ?? 0);
        return Promise.reject(new Error(`${provider.id}: simulated failure`));
      }

      const latency = latencies[index % latencies.length] ?? 0;
      // The server reads its clock at the midpoint of the round trip.
      world.advance(latency / 2);
      const answer = world.serverMs + (options.serverErrorMs ?? 0);
      world.advance(latency / 2);
      return Promise.resolve(answer);
    },
  };
  return provider;
}

/**
 * Drains pending microtasks so a fire-and-forget re-sync can finish.
 *
 * Deliberately not `clock.sync()`: awaiting that would *cause* the sync the
 * test is trying to observe.
 */
async function flush(): Promise<void> {
  for (let turn = 0; turn < 32; turn += 1) await Promise.resolve();
}

function makeClock(world: FakeWorld, overrides: TrueTimeOptions = {}): TrueTimeClock {
  return new TrueTimeClock({
    providers: [fakeProvider(world)],
    samples: 3,
    monotonic: world.monotonic,
    deviceNow: world.deviceNow,
    scheduler: world.scheduler,
    visibility: null,
    ...overrides,
  });
}

describe('estimateOffset', () => {
  it('returns the median offset, not the mean', () => {
    const estimate = estimateOffset([
      { offsetMs: 100, rttMs: 40 },
      { offsetMs: 104, rttMs: 44 },
      { offsetMs: 102, rttMs: 42 },
    ]);

    expect(estimate?.offsetMs).toBe(102);
    expect(estimate?.used).toBe(3);
  });

  it('discards high-RTT outliers before averaging', () => {
    const estimate = estimateOffset([
      { offsetMs: 100, rttMs: 40 },
      { offsetMs: 101, rttMs: 42 },
      { offsetMs: 102, rttMs: 44 },
      // A stalled request whose offset is wildly wrong. Its RTT exceeds
      // 1.5x the median, so it must not reach the median calculation.
      { offsetMs: 900, rttMs: 4_000 },
    ]);

    expect(estimate?.discarded).toBe(1);
    expect(estimate?.offsetMs).toBe(101);
  });

  it('derives uncertainty from the best round trip and the source resolution', () => {
    const estimate = estimateOffset(
      [
        { offsetMs: 0, rttMs: 60 },
        { offsetMs: 0, rttMs: 80 },
      ],
      1_000,
    );

    expect(estimate?.uncertaintyMs).toBe(60 / 2 + 500);
  });

  it('returns null with nothing to work from', () => {
    expect(estimateOffset([])).toBeNull();
  });

  it('keeps every sample when they are all equally slow', () => {
    const estimate = estimateOffset([
      { offsetMs: 10, rttMs: 500 },
      { offsetMs: 20, rttMs: 500 },
    ]);

    expect(estimate?.used).toBe(2);
    expect(estimate?.offsetMs).toBe(15);
  });
});

describe('TrueTimeClock sync', () => {
  it('runs on the device clock before any sync, flagged as degraded', () => {
    const world = new FakeWorld();
    const clock = makeClock(world);

    expect(clock.now()).toBe(world.deviceMs);
    const state = clock.getStatus();
    expect(state.tier).toBe('device-clock');
    expect(state.degraded).toBe(true);
    expect(state.synced).toBe(false);
    expect(state.skewWarning).toBe(false);

    clock.dispose();
  });

  it('corrects a fast device clock and reports the offset', async () => {
    const world = new FakeWorld();
    // The device is 90 seconds ahead of the world.
    world.deviceMs = world.serverMs + 90_000;

    const clock = makeClock(world);
    const state = await clock.init();

    expect(state.synced).toBe(true);
    expect(state.tier).toBe('ntp-lite');
    expect(state.sourceId).toBe('fake');
    expect(state.offsetMs).toBeCloseTo(-90_000, 0);
    expect(state.skewWarning).toBe(true);
    expect(clock.now()).toBeCloseTo(world.serverMs, 0);

    clock.dispose();
  });

  it('does not warn about skew within the threshold', async () => {
    const world = new FakeWorld();
    world.deviceMs = world.serverMs + 1_000;

    const clock = makeClock(world);
    const state = await clock.init();

    expect(state.synced).toBe(true);
    expect(state.skewWarning).toBe(false);

    clock.dispose();
  });

  it('compensates for round-trip latency rather than trusting the raw answer', async () => {
    const world = new FakeWorld();
    const provider = fakeProvider(world, { latencies: [400] });

    const clock = makeClock(world, { providers: [provider] });
    await clock.init();

    // Without the RTT/2 correction the clock would sit ~200 ms in the past.
    expect(clock.now()).toBeCloseTo(world.serverMs, 0);
    expect(clock.getStatus().uncertaintyMs).toBeCloseTo(200.5, 0);

    clock.dispose();
  });

  it('tolerates individual failed samples', async () => {
    const world = new FakeWorld();
    const provider = fakeProvider(world, { failAt: [0], latencies: [40] });

    const clock = makeClock(world, { providers: [provider], samples: 3 });
    const state = await clock.init();

    expect(state.synced).toBe(true);
    expect(state.sampleCount).toBe(2);

    clock.dispose();
  });
});

describe('fallback chain', () => {
  it('falls through to the next provider when the primary is down', async () => {
    const world = new FakeWorld();
    const primary = fakeProvider(world, { id: 'primary', alwaysFail: true });
    const secondary = fakeProvider(world, { id: 'secondary' });

    const clock = makeClock(world, { providers: [primary, secondary] });
    const state = await clock.init();

    expect(primary.calls).toBe(3);
    expect(state.sourceId).toBe('secondary');
    expect(state.tier).toBe('ntp-lite');

    clock.dispose();
  });

  it('falls through to the coarse http-date tier and reports it', async () => {
    const world = new FakeWorld();
    const clock = makeClock(world, {
      providers: [
        fakeProvider(world, { id: 'primary', alwaysFail: true }),
        fakeProvider(world, { id: 'secondary', alwaysFail: true }),
        fakeProvider(world, { id: 'http-date', tier: 'http-date', resolutionMs: 1_000 }),
      ],
    });

    const state = await clock.init();

    expect(state.sourceId).toBe('http-date');
    expect(state.tier).toBe('http-date');
    expect(state.degraded).toBe(false);
    // A one-second-resolution source cannot claim better than half a second.
    expect(state.uncertaintyMs).toBeGreaterThanOrEqual(500);

    clock.dispose();
  });

  it('degrades to the device clock when everything fails, and keeps running', async () => {
    const world = new FakeWorld();
    const clock = makeClock(world, {
      providers: [
        fakeProvider(world, { id: 'primary', alwaysFail: true }),
        fakeProvider(world, { id: 'secondary', alwaysFail: true }),
      ],
    });

    const state = await clock.init();

    expect(state.synced).toBe(false);
    expect(state.tier).toBe('device-clock');
    expect(state.degraded).toBe(true);
    expect(state.sourceId).toBeNull();

    // The countdown must still advance — a failed sync is never a blank screen.
    const before = clock.now();
    world.advance(5_000);
    expect(clock.now() - before).toBeCloseTo(5_000, 0);

    clock.dispose();
  });

  it('degrades rather than rejecting when a provider throws synchronously', async () => {
    const world = new FakeWorld();
    const exploding: TimeProvider = {
      id: 'exploding',
      tier: 'ntp-lite',
      resolutionMs: 1,
      fetchServerTime: () => {
        throw new Error('no fetch in this environment');
      },
    };

    const clock = makeClock(world, { providers: [exploding] });
    await expect(clock.init()).resolves.toMatchObject({ tier: 'device-clock' });

    clock.dispose();
  });
});

describe('monotonic progression', () => {
  it('always returns an integral epoch, whatever the monotonic source reports', async () => {
    const world = new FakeWorld();
    const clock = makeClock(world);
    await clock.init();

    // Temporal rejects fractional epochs with `Expected finite integer`, which
    // blanked the page on ~3% of loads when `now()` leaked sub-millisecond
    // precision from `performance.now()`.
    for (const step of [0.1, 0.25, 0.5, 0.75, 1.3, 7.9999, 0.0001]) {
      world.advance(step);
      const value = clock.now();
      expect(Number.isInteger(value)).toBe(true);
    }

    clock.dispose();
  });

  it('ignores the OS clock jumping forward mid-session', async () => {
    const world = new FakeWorld();
    const clock = makeClock(world);
    await clock.init();

    const before = clock.now();
    world.advance(1_000);
    // Somebody drags the system clock an hour ahead.
    world.skewDevice(3_600_000);

    expect(clock.now() - before).toBeCloseTo(1_000, 0);

    clock.dispose();
  });

  it('ignores the OS clock jumping backward mid-session', async () => {
    const world = new FakeWorld();
    const clock = makeClock(world);
    await clock.init();

    const before = clock.now();
    world.advance(2_000);
    world.skewDevice(-7_200_000);

    const after = clock.now();
    expect(after).toBeGreaterThan(before);
    expect(after - before).toBeCloseTo(2_000, 0);

    clock.dispose();
  });

  it('never goes backwards while slewing a negative correction', async () => {
    const world = new FakeWorld();
    const clock = makeClock(world);
    await clock.init();

    // A small correction arrives that would pull the clock back 500 ms.
    world.skewServer(-500);
    await clock.sync();

    let previous = clock.now();
    for (let step = 0; step < 40; step += 1) {
      world.advance(250);
      const current = clock.now();
      expect(current).toBeGreaterThan(previous);
      previous = current;
    }

    clock.dispose();
  });
});

describe('re-sync corrections', () => {
  it('slews a small correction in gradually instead of jumping', async () => {
    const world = new FakeWorld();
    const clock = makeClock(world, { maxSlewMs: 2_000, slewRate: 0.05 });
    await clock.init();

    // The world moves 400 ms ahead of where we thought it was.
    world.skewServer(400);
    await clock.sync();

    const immediately = clock.now();
    // A step would have shown the whole 400 ms at once.
    expect(Math.abs(immediately - world.serverMs)).toBeGreaterThan(300);

    // At 5% of elapsed time, 400 ms takes 8 s of wall clock to bleed in.
    world.advance(10_000);
    expect(clock.now()).toBeCloseTo(world.serverMs, -1);

    clock.dispose();
  });

  it('clamps an absurd slew rate so the clock still cannot tick backwards', async () => {
    const world = new FakeWorld();
    // A rate of 1 or more would let the correction out-run the clock itself.
    const clock = makeClock(world, { slewRate: 5, maxSlewMs: 2_000 });
    await clock.init();

    world.skewServer(-1_500);
    await clock.sync();

    let previous = clock.now();
    for (let step = 0; step < 20; step += 1) {
      world.advance(100);
      const current = clock.now();
      expect(current).toBeGreaterThan(previous);
      previous = current;
    }

    clock.dispose();
  });

  it('steps a large correction at once', async () => {
    const world = new FakeWorld();
    const clock = makeClock(world, { maxSlewMs: 2_000 });
    await clock.init();

    world.skewServer(30_000);
    await clock.sync();

    expect(clock.now()).toBeCloseTo(world.serverMs, 0);

    clock.dispose();
  });

  it('re-syncs on the background interval', async () => {
    const world = new FakeWorld();
    const provider = fakeProvider(world);
    const clock = makeClock(world, { providers: [provider], resyncIntervalMs: 60_000 });
    await clock.init();

    const callsAfterInit = provider.calls;
    expect(world.intervals.size).toBe(1);

    world.advance(60_000);
    world.fireIntervals();
    await flush();

    expect(provider.calls).toBeGreaterThan(callsAfterInit);

    clock.dispose();
  });

  it('re-syncs when the tab becomes visible again', async () => {
    const world = new FakeWorld();
    const provider = fakeProvider(world);
    const listeners = new Set<() => void>();
    let visible = true;
    const visibility: VisibilitySource = {
      isVisible: () => visible,
      onChange: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    };

    const clock = makeClock(world, {
      providers: [provider],
      visibility,
      minResyncIntervalMs: 60_000,
    });
    await clock.init();
    const callsAfterInit = provider.calls;

    // Hidden -> nothing happens.
    visible = false;
    for (const listener of listeners) listener();
    await flush();
    expect(provider.calls).toBe(callsAfterInit);

    // Visible again, but too soon after the last attempt: still nothing, so a
    // viewer flicking between tabs cannot hammer the time API.
    visible = true;
    for (const listener of listeners) listener();
    await flush();
    expect(provider.calls).toBe(callsAfterInit);

    // Visible again after a long sleep: re-sync.
    world.advance(10 * 60_000);
    for (const listener of listeners) listener();
    await flush();
    expect(provider.calls).toBeGreaterThan(callsAfterInit);

    clock.dispose();
  });

  it('coalesces overlapping sync calls into one run', async () => {
    const world = new FakeWorld();
    const provider = fakeProvider(world);
    const clock = makeClock(world, { providers: [provider], samples: 3 });

    const [a, b] = await Promise.all([clock.sync(), clock.sync()]);

    expect(provider.calls).toBe(3);
    expect(a).toEqual(b);

    clock.dispose();
  });
});

describe('teardown', () => {
  it('clears its interval and visibility listener on dispose', async () => {
    const world = new FakeWorld();
    let unsubscribed = false;
    const visibility: VisibilitySource = {
      isVisible: () => true,
      onChange: () => () => {
        unsubscribed = true;
      },
    };

    const clock = makeClock(world, { visibility, resyncIntervalMs: 60_000 });
    await clock.init();

    expect(world.intervals.size).toBe(1);
    clock.dispose();
    expect(world.intervals.size).toBe(0);
    expect(unsubscribed).toBe(true);
  });

  it('leaks no pending sample timeouts', async () => {
    const world = new FakeWorld();
    const clock = makeClock(world, {
      providers: [fakeProvider(world, { failAt: [1] }), fakeProvider(world)],
    });

    await clock.init();
    expect(world.timeouts.size).toBe(0);

    clock.dispose();
  });

  it('stops syncing after dispose', async () => {
    const world = new FakeWorld();
    const provider = fakeProvider(world);
    const clock = makeClock(world, { providers: [provider] });
    await clock.init();

    const calls = provider.calls;
    clock.dispose();
    await clock.sync();

    expect(provider.calls).toBe(calls);
  });

  it('notifies and then releases subscribers', async () => {
    const world = new FakeWorld();
    const clock = makeClock(world);
    const seen: string[] = [];

    const unsubscribe = clock.subscribe((state) => seen.push(state.tier));
    expect(seen).toEqual(['device-clock']);

    await clock.init();
    expect(seen).toEqual(['device-clock', 'ntp-lite']);

    unsubscribe();
    await clock.sync();
    expect(seen).toHaveLength(2);

    clock.dispose();
  });
});

describe('getRemaining', () => {
  it('reads the shared clock when no instant is given', () => {
    disposeTrueTime();
    const world = new FakeWorld();
    getTrueTimeClock({
      providers: [],
      monotonic: world.monotonic,
      deviceNow: world.deviceNow,
      scheduler: world.scheduler,
      visibility: null,
      resyncIntervalMs: 0,
    });

    const remaining = getRemaining(world.deviceMs + 90_000);
    expect(remaining.totalSeconds).toBe(90);
    expect(remaining.expired).toBe(false);

    disposeTrueTime();
  });

  it('accepts an explicit instant', () => {
    expect(getRemaining(10_000, 4_000).totalSeconds).toBe(6);
  });
});
