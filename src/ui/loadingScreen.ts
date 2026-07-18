/**
 * The themed loading state.
 *
 * The markup lives in `index.html` so the gears are on screen before this
 * module — or three.js — has even parsed. This class adopts that element,
 * drives it from real `LoadingTracker` progress, and takes it down again.
 *
 * Two timing rules, both about not lying to the viewer:
 *
 * - **Minimum display time.** A boot that finishes in 80 ms would otherwise
 *   flash the screen and look like a glitch. Below the floor the screen stays
 *   up for the rest of it.
 * - **Hard ceiling.** If something never reports done, the screen leaves anyway.
 *   A stuck loader must not be able to hide the clock permanently.
 */

import type { LoadingTracker } from '../app/loading.js';

export interface LoadingScreenOptions {
  readonly element: HTMLElement;
  readonly tracker: LoadingTracker;
  /** Shortest time the screen may be visible. Defaults to 650 ms. */
  readonly minimumMs?: number;
  /** Longest the screen may be visible regardless of progress. Defaults to 12 s. */
  readonly timeoutMs?: number;
}

const DEFAULT_MINIMUM_MS = 650;
const DEFAULT_TIMEOUT_MS = 12_000;
/** Must match the `.loader` transition in styles.css. */
const FADE_MS = 420;

export class LoadingScreen {
  private readonly element: HTMLElement;
  private readonly bar: HTMLElement | null;
  private readonly caption: HTMLElement | null;
  private readonly percent: HTMLElement | null;
  private readonly minimumMs: number;
  private readonly startedAt = performance.now();
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();
  private readonly unsubscribe: () => void;
  private hiding = false;

  constructor(options: LoadingScreenOptions) {
    this.element = options.element;
    this.minimumMs = options.minimumMs ?? DEFAULT_MINIMUM_MS;
    this.bar = this.element.querySelector('.loader__bar-fill');
    this.caption = this.element.querySelector('.loader__caption');
    this.percent = this.element.querySelector('.loader__percent');

    this.unsubscribe = options.tracker.subscribe((snapshot) => {
      const percent = Math.round(snapshot.progress * 100);
      if (this.bar) this.bar.style.width = `${percent}%`;
      if (this.percent) this.percent.textContent = `${percent}%`;
      if (this.caption && snapshot.pending.length > 0) this.caption.textContent = snapshot.label;
      if (snapshot.done) this.hide();
    });

    this.after(options.timeoutMs ?? DEFAULT_TIMEOUT_MS, () => {
      this.hide({ immediate: true });
    });
  }

  /** Fades the screen out, respecting the minimum display time. */
  hide(options: { immediate?: boolean } = {}): void {
    if (this.hiding) return;

    const elapsed = performance.now() - this.startedAt;
    const remaining = this.minimumMs - elapsed;
    if (!options.immediate && remaining > 0) {
      this.after(remaining, () => {
        this.hide();
      });
      return;
    }

    this.hiding = true;
    this.element.classList.add('loader--done');
    this.element.setAttribute('aria-hidden', 'true');
    this.after(FADE_MS, () => this.element.remove());
  }

  dispose(): void {
    this.unsubscribe();
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
    this.element.remove();
  }

  private after(delayMs: number, run: () => void): void {
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      run();
    }, delayMs);
    this.timers.add(timer);
  }
}
