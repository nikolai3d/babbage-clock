/**
 * Trusted current time.
 *
 * The device clock is not trusted for *absolute* time — a viewer whose laptop
 * is three minutes fast would see the rings hit zero three minutes early, which
 * is the one thing a countdown must never do. It is trusted for *elapsed* time,
 * via `performance.now()`, which is monotonic and unaffected by NTP steps, the
 * user dragging the clock in system settings, or DST.
 *
 * So: sync once against a network source, remember the correction against a
 * monotonic mark, and from then on report `syncedEpoch + (monotonic - mark)`.
 * `Date.now()` is read only at sync points, never for progression.
 *
 * Pure of DOM and three.js: `document` and `fetch` are reached through
 * injectable seams, so the whole file unit-tests in plain Node with no network.
 */

import { computeRemaining } from './countdown.js';
import { defaultProviders } from './providers.js';
import type { RemainingTime } from './countdown.js';
import type { AccuracyTier, TimeProvider } from './providers.js';
import type { TimeSource } from './target.js';

export type { AccuracyTier, TimeProvider } from './providers.js';

/** Round trips slower than `median * this` are dropped before averaging. */
const OUTLIER_RTT_FACTOR = 1.5;
/** Fewer good samples than this and we move on to the next provider. */
const MIN_SAMPLES = 2;
/** |offset| above this is reported as a device-clock problem worth telling the viewer about. */
export const DEFAULT_SKEW_WARN_MS = 5_000;
/** Corrections smaller than this are eased in; larger ones are applied at once. */
export const DEFAULT_MAX_SLEW_MS = 2_000;
/** Hard ceiling on the slew rate; see the clamp in the constructor. */
const MAX_SLEW_RATE = 0.5;

export interface TrueTimeStatus {
  /** How the current correction was obtained. `device-clock` means unsynced. */
  readonly tier: AccuracyTier;
  /** Provider id behind the current correction, or null when unsynced. */
  readonly sourceId: string | null;
  /** Measured device-clock error: `trueTime - Date.now()`, in ms. */
  readonly offsetMs: number;
  /** Estimated error of `offsetMs` itself, in ms. */
  readonly uncertaintyMs: number;
  /** Corrected epoch ms of the last successful sync, or null. */
  readonly lastSyncMs: number | null;
  /** Samples that survived outlier rejection in the last successful sync. */
  readonly sampleCount: number;
  /** True once any network source has been believed. */
  readonly synced: boolean;
  /** True when the device clock is off by more than the warning threshold. */
  readonly skewWarning: boolean;
  /** True while running on the untrusted device clock. */
  readonly degraded: boolean;
}

export interface OffsetSample {
  /** `serverTime - clientMidpoint`, in ms. */
  readonly offsetMs: number;
  /** Round-trip time of the request that produced it, in ms. */
  readonly rttMs: number;
}

export interface OffsetEstimate {
  readonly offsetMs: number;
  readonly uncertaintyMs: number;
  readonly used: number;
  readonly discarded: number;
}

/** Injected so tests can drive re-sync timing without real timers. */
export interface Scheduler {
  setInterval: (handler: () => void, ms: number) => ReturnType<typeof setInterval>;
  clearInterval: (handle: ReturnType<typeof setInterval>) => void;
  setTimeout: (handler: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimeout: (handle: ReturnType<typeof setTimeout>) => void;
}

/** Injected so tests can simulate tab sleep without a DOM. */
export interface VisibilitySource {
  isVisible: () => boolean;
  /** Subscribes to visibility changes; returns an unsubscribe. */
  onChange: (listener: () => void) => () => void;
}

export interface TrueTimeOptions {
  /** Fallback chain, best first. Defaults to `defaultProviders()`. */
  readonly providers?: readonly TimeProvider[] | undefined;
  /** Round trips per provider. 3–5 is the useful range. Default 5. */
  readonly samples?: number | undefined;
  /** Per-request abort deadline in ms. Default 3000. */
  readonly sampleTimeoutMs?: number | undefined;
  /** Background re-sync period in ms; 0 disables. Default 45 min. */
  readonly resyncIntervalMs?: number | undefined;
  /** Ignore visibility-triggered re-syncs closer together than this. Default 60 s. */
  readonly minResyncIntervalMs?: number | undefined;
  /** Corrections at or below this magnitude are slewed. Default 2000 ms. */
  readonly maxSlewMs?: number | undefined;
  /** Slew speed as a fraction of elapsed time. Must be < 1. Default 0.05. */
  readonly slewRate?: number | undefined;
  /** |offset| above this sets `skewWarning`. Default 5000 ms. */
  readonly skewWarnMs?: number | undefined;
  /** Monotonic millisecond source. Defaults to `performance.now()`. */
  readonly monotonic?: (() => number) | undefined;
  /** Device wall clock, read only at sync points. Defaults to `Date.now()`. */
  readonly deviceNow?: (() => number) | undefined;
  /** Tab-visibility seam; `null` disables visibility re-sync. */
  readonly visibility?: VisibilitySource | null | undefined;
  readonly scheduler?: Scheduler | undefined;
}

/**
 * Median offset of the samples that were not obviously delayed.
 *
 * The median rather than the mean because a single stalled request skews a mean
 * badly and a median not at all; the RTT filter on top of it because a slow
 * round trip is asymmetric far more often than not, which biases the estimate
 * even when the arithmetic is sound.
 *
 * Returns null when there is nothing usable.
 */
export function estimateOffset(
  samples: readonly OffsetSample[],
  resolutionMs = 1,
): OffsetEstimate | null {
  if (samples.length === 0) return null;

  const medianRtt = median(samples.map((sample) => sample.rttMs));
  const kept = samples.filter((sample) => sample.rttMs <= medianRtt * OUTLIER_RTT_FACTOR);
  const used = kept.length > 0 ? kept : [...samples];

  const bestRtt = Math.min(...used.map((sample) => sample.rttMs));

  return {
    offsetMs: median(used.map((sample) => sample.offsetMs)),
    // Half the best round trip bounds the asymmetry we cannot see; the source's
    // own quantisation adds to it.
    uncertaintyMs: bestRtt / 2 + resolutionMs / 2,
    used: used.length,
    discarded: samples.length - used.length,
  };
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[middle] ?? 0;
  return ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
}

const defaultScheduler: Scheduler = {
  setInterval: (handler, ms) => setInterval(handler, ms),
  clearInterval: (handle) => {
    clearInterval(handle);
  },
  setTimeout: (handler, ms) => setTimeout(handler, ms),
  clearTimeout: (handle) => {
    clearTimeout(handle);
  },
};

function documentVisibility(): VisibilitySource | null {
  if (typeof document === 'undefined') return null;
  return {
    isVisible: () => !document.hidden,
    onChange: (listener) => {
      document.addEventListener('visibilitychange', listener);
      return () => {
        document.removeEventListener('visibilitychange', listener);
      };
    },
  };
}

/**
 * `TrueTimeOptions` with every default filled in.
 *
 * Spelled out rather than derived with `Required<…>`: under
 * `exactOptionalPropertyTypes` that utility strips the `?` but keeps the
 * explicit `| undefined`, so every read would still need a null check.
 */
interface ResolvedOptions {
  readonly samples: number;
  readonly sampleTimeoutMs: number;
  readonly resyncIntervalMs: number;
  readonly minResyncIntervalMs: number;
  readonly maxSlewMs: number;
  readonly slewRate: number;
  readonly skewWarnMs: number;
  readonly monotonic: () => number;
  readonly deviceNow: () => number;
}

/**
 * A clock that is monotonic within the session and corrected against the
 * network. Satisfies `TimeSource`, so the renderer takes it as a drop-in.
 */
export class TrueTimeClock implements TimeSource {
  private readonly options: ResolvedOptions;
  private readonly providers: readonly TimeProvider[];
  private readonly visibility: VisibilitySource | null;
  private readonly scheduler: Scheduler;

  /** Corrected epoch ms at `baseMark`. */
  private baseEpochMs: number;
  /** Monotonic reading that `baseEpochMs` was taken at. */
  private baseMark: number;
  /** Correction still to be eased in, in ms. */
  private slewRemainingMs = 0;
  private slewMark: number;

  private tier: AccuracyTier = 'device-clock';
  private sourceId: string | null = null;
  private offsetMs = 0;
  private uncertaintyMs = Number.POSITIVE_INFINITY;
  private lastSyncMs: number | null = null;
  private sampleCount = 0;
  private synced = false;

  private inFlight: Promise<TrueTimeStatus> | null = null;
  private controller: AbortController | null = null;
  private lastAttemptMark = Number.NEGATIVE_INFINITY;
  private intervalHandle: ReturnType<typeof setInterval> | null = null;
  private unsubscribeVisibility: (() => void) | null = null;
  private readonly listeners = new Set<(status: TrueTimeStatus) => void>();
  private disposed = false;

  constructor(options: TrueTimeOptions = {}) {
    this.options = {
      samples: options.samples ?? 5,
      sampleTimeoutMs: options.sampleTimeoutMs ?? 3_000,
      resyncIntervalMs: options.resyncIntervalMs ?? 45 * 60 * 1_000,
      minResyncIntervalMs: options.minResyncIntervalMs ?? 60_000,
      maxSlewMs: options.maxSlewMs ?? DEFAULT_MAX_SLEW_MS,
      // Clamped below 1 rather than trusted: at a rate of 1 or more a backwards
      // correction would out-run the clock and the readout would tick
      // backwards, which is the one thing slewing exists to prevent.
      slewRate: Math.min(MAX_SLEW_RATE, Math.max(0, options.slewRate ?? 0.05)),
      skewWarnMs: options.skewWarnMs ?? DEFAULT_SKEW_WARN_MS,
      monotonic: options.monotonic ?? (() => performance.now()),
      deviceNow: options.deviceNow ?? (() => Date.now()),
    };
    this.providers = options.providers ?? defaultProviders();
    this.visibility = options.visibility === undefined ? documentVisibility() : options.visibility;
    this.scheduler = options.scheduler ?? defaultScheduler;

    // Start on the device clock so the countdown runs from frame one. A failed
    // or slow sync therefore degrades the accuracy tier, never the display.
    this.baseMark = this.options.monotonic();
    this.slewMark = this.baseMark;
    this.baseEpochMs = this.options.deviceNow();
  }

  /** Corrected UTC epoch ms. Monotonic within the session apart from step corrections. */
  now(): number {
    const mark = this.options.monotonic();
    this.advanceSlew(mark);
    return this.baseEpochMs + (mark - this.baseMark);
  }

  /** Syncs once and starts the re-sync timers. Safe to call more than once. */
  async init(): Promise<TrueTimeStatus> {
    this.startResyncTimers();
    return this.sync();
  }

  /**
   * Runs the fallback chain and applies the resulting correction.
   *
   * Never rejects: a total failure resolves with a `device-clock` status, since
   * "we could not reach anything" is information for the UI, not an error the
   * caller can do anything about.
   */
  async sync(): Promise<TrueTimeStatus> {
    if (this.disposed) return this.getStatus();
    this.inFlight ??= this.runSync().finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  getStatus(): TrueTimeStatus {
    return {
      tier: this.tier,
      sourceId: this.sourceId,
      offsetMs: this.offsetMs,
      uncertaintyMs: this.uncertaintyMs,
      lastSyncMs: this.lastSyncMs,
      sampleCount: this.sampleCount,
      synced: this.synced,
      skewWarning: this.synced && Math.abs(this.offsetMs) > this.options.skewWarnMs,
      degraded: this.tier === 'device-clock',
    };
  }

  /** Subscribes to status changes and immediately delivers the current one. */
  subscribe(listener: (status: TrueTimeStatus) => void): () => void {
    this.listeners.add(listener);
    listener(this.getStatus());
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Stops all timers and listeners and aborts any in-flight request. */
  dispose(): void {
    this.disposed = true;
    if (this.intervalHandle !== null) {
      this.scheduler.clearInterval(this.intervalHandle);
      this.intervalHandle = null;
    }
    this.unsubscribeVisibility?.();
    this.unsubscribeVisibility = null;
    this.controller?.abort();
    this.controller = null;
    this.listeners.clear();
  }

  // -------------------------------------------------------------------------

  private startResyncTimers(): void {
    if (this.disposed) return;

    const { resyncIntervalMs } = this.options;
    if (resyncIntervalMs > 0 && this.intervalHandle === null) {
      this.intervalHandle = this.scheduler.setInterval(() => {
        this.requestResync(0);
      }, resyncIntervalMs);
    }

    if (this.visibility && this.unsubscribeVisibility === null) {
      const visibility = this.visibility;
      this.unsubscribeVisibility = visibility.onChange(() => {
        // Coming back from a sleeping tab is exactly when the monotonic clock
        // and the world are most likely to have drifted apart.
        if (visibility.isVisible()) this.requestResync(this.options.minResyncIntervalMs);
      });
    }
  }

  /** Fire-and-forget re-sync with a floor on how often it may actually run. */
  private requestResync(minIntervalMs: number): void {
    if (this.disposed) return;
    const mark = this.options.monotonic();
    if (mark - this.lastAttemptMark < minIntervalMs) return;
    // sync() never rejects, but an explicit catch keeps a future refactor from
    // turning this into an unhandled rejection.
    void this.sync().catch(() => undefined);
  }

  private async runSync(): Promise<TrueTimeStatus> {
    this.lastAttemptMark = this.options.monotonic();

    for (const provider of this.providers) {
      const samples = await this.collectSamples(provider);
      if (samples.length < Math.min(MIN_SAMPLES, this.options.samples)) continue;

      const estimate = estimateOffset(samples, provider.resolutionMs);
      if (!estimate) continue;

      this.applyEstimate(provider, estimate);
      this.emit();
      return this.getStatus();
    }

    // Disposed while the chain was in flight: leave the status alone rather
    // than reporting a failure nobody asked about.
    if (this.disposed) return this.getStatus();

    // Nothing answered. Keep ticking on whatever base we already have and say so.
    this.tier = 'device-clock';
    this.sourceId = null;
    if (!this.synced) this.uncertaintyMs = Number.POSITIVE_INFINITY;
    this.emit();
    return this.getStatus();
  }

  private applyEstimate(provider: TimeProvider, estimate: OffsetEstimate): void {
    const mark = this.options.monotonic();
    // The one place the device clock is read for anything but elapsed time: the
    // offset is measured against it, so applying it needs one fresh reading.
    const corrected = this.options.deviceNow() + estimate.offsetMs;

    this.applyCorrection(corrected, mark);

    this.tier = provider.tier;
    this.sourceId = provider.id;
    this.offsetMs = estimate.offsetMs;
    this.uncertaintyMs = estimate.uncertaintyMs;
    this.sampleCount = estimate.used;
    this.synced = true;
    this.lastSyncMs = this.baseEpochMs + (this.options.monotonic() - this.baseMark);
  }

  /**
   * Moves the clock to `targetEpochMs` as of monotonic `mark`.
   *
   * Small corrections are slewed rather than stepped: a 200 ms jump applied at
   * once would visibly snap the second hand, whereas easing it in over a few
   * seconds is imperceptible. Large ones are stepped, because pretending a
   * ten-minute error away slowly is worse than one honest jump.
   */
  private applyCorrection(targetEpochMs: number, mark: number): void {
    this.advanceSlew(mark);
    const currentEpochMs = this.baseEpochMs + (mark - this.baseMark);
    const deltaMs = targetEpochMs - currentEpochMs;

    if (Math.abs(deltaMs) <= this.options.maxSlewMs) {
      this.slewRemainingMs = deltaMs;
      this.slewMark = mark;
      return;
    }

    this.baseEpochMs = targetEpochMs;
    this.baseMark = mark;
    this.slewRemainingMs = 0;
    this.slewMark = mark;
  }

  /**
   * Bleeds the pending correction into the base at `slewRate`.
   *
   * The rate must stay below 1 so that even a backwards correction leaves the
   * reported time strictly increasing — the rings must never tick backwards.
   */
  private advanceSlew(mark: number): void {
    if (this.slewRemainingMs === 0) {
      this.slewMark = mark;
      return;
    }

    const elapsed = Math.max(0, mark - this.slewMark);
    this.slewMark = mark;

    const budget = elapsed * this.options.slewRate;
    const magnitude = Math.min(Math.abs(this.slewRemainingMs), budget);
    const applied = Math.sign(this.slewRemainingMs) * magnitude;

    this.baseEpochMs += applied;
    this.slewRemainingMs -= applied;
  }

  private async collectSamples(provider: TimeProvider): Promise<OffsetSample[]> {
    const samples: OffsetSample[] = [];

    for (let index = 0; index < this.options.samples; index += 1) {
      if (this.disposed) break;
      try {
        samples.push(await this.takeSample(provider));
      } catch {
        // One bad round trip is normal; the loop keeps going and the provider
        // is only abandoned if too few samples survive.
      }
    }

    return samples;
  }

  private async takeSample(provider: TimeProvider): Promise<OffsetSample> {
    const controller = new AbortController();
    this.controller = controller;

    const timer = this.scheduler.setTimeout(() => {
      controller.abort();
    }, this.options.sampleTimeoutMs);

    const startMark = this.options.monotonic();
    const startDevice = this.options.deviceNow();

    try {
      const serverEpochMs = await provider.fetchServerTime(controller.signal);
      const rttMs = Math.max(0, this.options.monotonic() - startMark);

      if (!Number.isFinite(serverEpochMs)) throw new Error(`${provider.id}: non-finite time`);

      // Assume symmetric latency: the server's reading describes the midpoint
      // of the round trip, so that is the client instant to compare it against.
      const clientMidpointMs = startDevice + rttMs / 2;
      return { offsetMs: serverEpochMs - clientMidpointMs, rttMs };
    } finally {
      this.scheduler.clearTimeout(timer);
      if (this.controller === controller) this.controller = null;
    }
  }

  private emit(): void {
    const status = this.getStatus();
    for (const listener of [...this.listeners]) listener(status);
  }
}

// ---------------------------------------------------------------------------
// Module-level convenience API. The renderer and UI use these; tests construct
// `TrueTimeClock` directly so they never share state.

let sharedClock: TrueTimeClock | null = null;

/** The process-wide clock, created on first use. */
export function getTrueTimeClock(options?: TrueTimeOptions): TrueTimeClock {
  sharedClock ??= new TrueTimeClock(options);
  return sharedClock;
}

/** Starts the shared clock. Resolves with the status, never rejects. */
export async function initTrueTime(options?: TrueTimeOptions): Promise<TrueTimeStatus> {
  return getTrueTimeClock(options).init();
}

/** Corrected UTC epoch ms from the shared clock. */
export function trueNow(): number {
  return getTrueTimeClock().now();
}

export function getTimeStatus(): TrueTimeStatus {
  return getTrueTimeClock().getStatus();
}

export function subscribeTimeStatus(listener: (status: TrueTimeStatus) => void): () => void {
  return getTrueTimeClock().subscribe(listener);
}

/** Tears down the shared clock. Call from HMR disposal and tests. */
export function disposeTrueTime(): void {
  sharedClock?.dispose();
  sharedClock = null;
}

/** The `TimeSource` the renderer injects: corrected, monotonic, one line to swap in. */
export const trueTimeSource: TimeSource = {
  now: () => trueNow(),
};

/** Remaining time to `targetEpochMs`, against the corrected clock by default. */
export function getRemaining(targetEpochMs: number, nowMs: number = trueNow()): RemainingTime {
  return computeRemaining(targetEpochMs, nowMs);
}
