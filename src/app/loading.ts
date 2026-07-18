/**
 * Weighted progress aggregation for the loading screen.
 *
 * The point of this module is that the loading screen shows *real* progress.
 * Anything slow that happens during boot registers a task and reports against
 * it; the screen shows the weighted total and the label of whatever is still
 * outstanding. Nothing here invents progress, so a task that cannot report
 * fractions simply goes 0 -> 1 when it finishes.
 *
 * This is the extension point for the texture and HDRI beads: a three.js
 * `LoadingManager` maps onto it directly —
 *
 * ```ts
 * const textures = tracker.task('textures', { label: 'Loading textures', weight: 4 });
 * manager.onProgress = (_url, loaded, total) => textures.progress(loaded / total);
 * manager.onLoad = () => textures.done();
 * ```
 *
 * Pure: no DOM, no timers. `ui/loadingScreen.ts` owns the pixels and the
 * minimum-display-time policy.
 */

export interface LoadingTask {
  readonly id: string;
  /** Reports completion of this task as a fraction; clamped and monotonic. */
  progress(fraction: number): void;
  /** Marks the task finished. Safe to call more than once. */
  done(): void;
}

export interface LoadingSnapshot {
  /** Weighted completion across every registered task, 0…1. */
  readonly progress: number;
  /** True when nothing is outstanding — including when nothing ever registered. */
  readonly done: boolean;
  /** Label of the first outstanding task, for the loading screen caption. */
  readonly label: string;
  /** Ids of the tasks still outstanding, in registration order. */
  readonly pending: readonly string[];
}

export interface LoadingTaskOptions {
  /** Shown while this task is the first outstanding one. */
  readonly label: string;
  /** Relative share of the bar. Defaults to 1. */
  readonly weight?: number;
}

interface TaskRecord {
  readonly id: string;
  readonly label: string;
  readonly weight: number;
  fraction: number;
}

const READY_LABEL = 'Ready';

export class LoadingTracker {
  private readonly tasks: TaskRecord[] = [];
  private readonly listeners = new Set<(snapshot: LoadingSnapshot) => void>();

  /**
   * Registers a unit of boot work. Registering the same id twice returns a
   * handle to the existing task rather than double-counting it.
   */
  task(id: string, options: LoadingTaskOptions): LoadingTask {
    const existing = this.tasks.find((task) => task.id === id);
    const record: TaskRecord = existing ?? {
      id,
      label: options.label,
      weight: options.weight !== undefined && options.weight > 0 ? options.weight : 1,
      fraction: 0,
    };
    if (!existing) {
      this.tasks.push(record);
      this.emit();
    }

    return {
      id,
      progress: (fraction: number) => {
        const next = clamp01(fraction);
        // Monotonic on purpose: a loader that re-reports a lower number (a
        // second manager starting, say) must not walk the bar backwards.
        if (next <= record.fraction) return;
        record.fraction = next;
        this.emit();
      },
      done: () => {
        if (record.fraction === 1) return;
        record.fraction = 1;
        this.emit();
      },
    };
  }

  getSnapshot(): LoadingSnapshot {
    const totalWeight = this.tasks.reduce((sum, task) => sum + task.weight, 0);
    const pending = this.tasks.filter((task) => task.fraction < 1);
    const progress =
      totalWeight === 0
        ? 1
        : this.tasks.reduce((sum, task) => sum + task.weight * task.fraction, 0) / totalWeight;

    return {
      progress,
      done: pending.length === 0,
      label: pending[0]?.label ?? READY_LABEL,
      pending: pending.map((task) => task.id),
    };
  }

  /** Subscribes and immediately delivers the current snapshot. */
  subscribe(listener: (snapshot: LoadingSnapshot) => void): () => void {
    this.listeners.add(listener);
    listener(this.getSnapshot());
    return () => {
      this.listeners.delete(listener);
    };
  }

  dispose(): void {
    this.listeners.clear();
  }

  private emit(): void {
    const snapshot = this.getSnapshot();
    for (const listener of [...this.listeners]) listener(snapshot);
  }
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}
