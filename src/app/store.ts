import type { CountdownParts } from '../time/countdown.js';
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
  /** Includes both-zone echoes and DST notes for the UI to surface. */
  readonly target: ResolvedTarget;
  readonly countdown: CountdownParts;
  /**
   * Accuracy of the clock the countdown is running on. The UI shows the tier
   * and the skew warning; it starts as `device-clock` and improves once the
   * first network sync lands.
   */
  readonly timeStatus: TrueTimeStatus;
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
