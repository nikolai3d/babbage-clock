/**
 * Keeps the countdown in the store advancing without a renderer.
 *
 * Normally `ClockRenderer`'s frame loop does this as a side effect of drawing
 * (see `docs/architecture.md`). When there is no WebGL context — creation
 * failed outright, or the one we had was lost — there are no frames, and the
 * countdown would freeze at whatever second the last one read. The site's core
 * promise is an accurate countdown, so the maths has to survive the loss of the
 * picture.
 *
 * Deliberately three.js-free and DOM-free: it composes the same
 * `computeCountdown` / `computeRemaining` the renderer uses over the same
 * `TimeSource`, so the fallback view cannot drift from the rings. `setInterval`
 * rather than `requestAnimationFrame`, because it has to keep running when the
 * page is not painting.
 */

import { computeCountdown, computeRemaining } from '../time/countdown.js';
import type { CountdownParts, RemainingTime } from '../time/countdown.js';
import type { TimeSource } from '../time/target.js';

/** Matches the renderer's store-push cadence, so the readout behaves the same. */
export const TICK_INTERVAL_MS = 250;

/**
 * The slice of the app store this needs. Structural, so the ticker can be
 * exercised without building a whole `AppState`; `AppStore` satisfies it.
 */
export interface CountdownStore {
  get(): { readonly target: { readonly atMs: number } };
  set(patch: { readonly countdown: CountdownParts; readonly remaining: RemainingTime }): void;
}

export interface CountdownTickerOptions {
  readonly store: CountdownStore;
  readonly timeSource: TimeSource;
  readonly intervalMs?: number;
}

export class CountdownTicker {
  private readonly store: CountdownStore;
  private readonly timeSource: TimeSource;
  private readonly intervalMs: number;
  private handle: ReturnType<typeof setInterval> | null = null;

  constructor(options: CountdownTickerOptions) {
    this.store = options.store;
    this.timeSource = options.timeSource;
    this.intervalMs = options.intervalMs ?? TICK_INTERVAL_MS;
  }

  get running(): boolean {
    return this.handle !== null;
  }

  /** Idempotent, and pushes one update immediately so nothing shows stale. */
  start(): void {
    this.tick();
    if (this.handle !== null) return;
    this.handle = setInterval(this.tick, this.intervalMs);
  }

  stop(): void {
    if (this.handle === null) return;
    clearInterval(this.handle);
    this.handle = null;
  }

  dispose(): void {
    this.stop();
  }

  /** One update. Exposed so a caller can refresh without owning the interval. */
  readonly tick = (): void => {
    const nowMs = this.timeSource.now();
    const targetMs = this.store.get().target.atMs;
    this.store.set({
      countdown: computeCountdown(targetMs, nowMs),
      remaining: computeRemaining(targetMs, nowMs),
    });
  };
}
