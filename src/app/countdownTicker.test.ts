import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CountdownTicker } from './countdownTicker.js';
import type { CountdownStore } from './countdownTicker.js';
import type { CountdownParts, RemainingTime } from '../time/countdown.js';

const TARGET_MS = 1_000_000;

function fakeStore(): CountdownStore & { patches: { remaining: RemainingTime }[] } {
  const patches: { countdown: CountdownParts; remaining: RemainingTime }[] = [];
  return {
    patches,
    get: () => ({ target: { atMs: TARGET_MS } }),
    set: (patch) => {
      patches.push(patch);
    },
  };
}

describe('CountdownTicker', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('pushes one update immediately, so nothing shows stale', () => {
    const store = fakeStore();
    const ticker = new CountdownTicker({ store, timeSource: { now: () => 0 }, intervalMs: 250 });

    ticker.start();
    expect(store.patches).toHaveLength(1);
    expect(store.patches[0]?.remaining.totalSeconds).toBe(1000);
    ticker.dispose();
  });

  it('keeps the countdown advancing with no renderer in sight', () => {
    const store = fakeStore();
    let nowMs = 0;
    const ticker = new CountdownTicker({
      store,
      timeSource: { now: () => nowMs },
      intervalMs: 250,
    });

    ticker.start();
    nowMs = 4000;
    vi.advanceTimersByTime(1000);

    expect(store.patches.length).toBeGreaterThan(1);
    expect(store.patches.at(-1)?.remaining.totalSeconds).toBe(996);
    ticker.dispose();
  });

  it('is idempotent to start and leaves no interval behind on stop', () => {
    const store = fakeStore();
    const ticker = new CountdownTicker({ store, timeSource: { now: () => 0 }, intervalMs: 250 });

    ticker.start();
    ticker.start();
    expect(ticker.running).toBe(true);

    const afterStarts = store.patches.length;
    ticker.stop();
    expect(ticker.running).toBe(false);

    vi.advanceTimersByTime(2000);
    expect(store.patches).toHaveLength(afterStarts);
    ticker.dispose();
  });
});
