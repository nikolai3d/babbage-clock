import type { EnvironmentPresetId } from '../scene/types.js';
import type { CountdownParts, RemainingTime } from '../time/countdown.js';
import type { ResolvedTarget } from '../time/target.js';
import type { TrueTimeStatus } from '../time/trueTime.js';

/**
 * The single source of truth shared by the renderer and the UI.
 *
 * The UI never reaches into three.js: it reads this state and calls the actions
 * on it. The renderer likewise only subscribes. Anything a future panel needs
 * to show or change belongs here.
 */
export interface AppState {
  readonly sceneId: string;
  /**
   * Lighting-mood override chosen in the settings panel, or null to use the
   * preset the active scene declares. See `scene/environment.ts`.
   */
  readonly mood: EnvironmentPresetId | null;
  /** Includes both-zone echoes and DST notes for the UI to surface. */
  readonly target: ResolvedTarget;
  readonly countdown: CountdownParts;
  /**
   * The countdown exactly as the rings display it: `HHH:MM:SS`, clamped at
   * 999:59:59 with `clamped` set beyond that. This is the readout to show
   * alongside the mechanism; `countdown` keeps the uncapped calendar split.
   */
  readonly remaining: RemainingTime;
  /**
   * Accuracy of the clock the countdown is running on. The UI shows the tier
   * and the skew warning; it starts as `device-clock` and improves once the
   * first network sync lands.
   */
  readonly timeStatus: TrueTimeStatus;
  /**
   * True until the first sync attempt settles. `TrueTimeStatus` cannot express
   * this — "not synced yet" and "sync failed" are the same status object — and
   * the UI needs the difference to avoid crying "device clock" for the second
   * before the network answers.
   */
  readonly syncPending: boolean;
  /**
   * Whether the settings drawer is open. It lives here rather than inside the
   * panel so that the rest of the UI (and the e2e suite) can observe it; the
   * clock is the hero, so it starts closed.
   */
  readonly settingsOpen: boolean;
  /** True while the render loop is idle because the tab is hidden. */
  readonly hidden: boolean;
  /** Frames per second, smoothed; surfaced for the diagnostics overlay. */
  readonly fps: number;
}

export type Listener<T> = (state: T, previous: T) => void;

/** Minimal observable store: no framework, no dependencies. */
export class Store<T extends object> {
  private state: T;
  private readonly listeners = new Set<Listener<T>>();

  constructor(initial: T) {
    this.state = initial;
  }

  get(): T {
    return this.state;
  }

  /** Applies a shallow patch and notifies subscribers if anything changed. */
  set(patch: Partial<T>): void {
    const previous = this.state;
    let changed = false;
    for (const key of Object.keys(patch) as (keyof T)[]) {
      const value = patch[key];
      if (value !== undefined && !Object.is(previous[key], value)) {
        changed = true;
        break;
      }
    }
    if (!changed) return;

    this.state = { ...previous, ...patch };
    for (const listener of [...this.listeners]) listener(this.state, previous);
  }

  /** Subscribes and immediately delivers the current state. Returns an unsubscribe. */
  subscribe(listener: Listener<T>): () => void {
    this.listeners.add(listener);
    listener(this.state, this.state);
    return () => {
      this.listeners.delete(listener);
    };
  }

  dispose(): void {
    this.listeners.clear();
  }
}

export type AppStore = Store<AppState>;
