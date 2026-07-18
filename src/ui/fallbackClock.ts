/**
 * The countdown without a GPU.
 *
 * Two failures land here, and neither is hypothetical:
 *
 * - **No WebGL at all.** Context creation throws — an old browser, a locked
 *   down enterprise build, a headless environment, hardware acceleration
 *   switched off. The 3D clock is gone; the countdown must not be.
 * - **Context loss.** The browser takes the context away while the page is
 *   running. On iOS this is routine: backgrounding the tab, memory pressure, a
 *   second WebGL page. A canvas left frozen on a stale frame is worse than no
 *   canvas, because it silently shows the wrong time.
 *
 * This view is driven by the same store as the rings, which `CountdownTicker`
 * keeps advancing while no frames are being drawn. It imports no three.js —
 * that is the point, and `docs/accessibility.md` says why it must stay that way.
 *
 * Announcements are not made here: `CountdownAnnouncer` owns the live region
 * for the countdown, and it keeps working whichever view is on screen. Only the
 * explanatory note is live, and it changes at most twice in a session.
 */

import { formatCountdown } from '../time/countdown.js';
import type { AppState, AppStore } from '../app/store.js';

export type FallbackReason =
  /** WebGL context creation failed; there will be no 3D view this session. */
  | 'no-webgl'
  /** The context was lost and the browser may still restore it. */
  | 'context-lost'
  /** The context was lost and did not come back. */
  | 'context-lost-permanent';

const NOTES: Record<FallbackReason, string> = {
  'no-webgl':
    'This browser could not start WebGL, so the three-dimensional mechanism cannot be drawn. ' +
    'The countdown below runs on the same clock and stays accurate.',
  'context-lost':
    'The graphics context was lost, so the mechanism has stopped drawing. ' +
    'Waiting for the browser to restore it — the countdown keeps running.',
  'context-lost-permanent':
    'The graphics context was lost and could not be restored. ' +
    'Reload the page to bring the mechanism back — the countdown keeps running either way.',
};

export interface FallbackClockOptions {
  readonly container: HTMLElement;
  readonly store: AppStore;
}

export class FallbackClock {
  readonly root: HTMLElement;

  private readonly countdownEl: HTMLParagraphElement;
  private readonly labelEl: HTMLParagraphElement;
  private readonly noteEl: HTMLParagraphElement;
  private readonly unsubscribe: () => void;
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();

  private reason: FallbackReason | null = null;
  private lastCountdown = '';
  private lastLabel = '';

  constructor(options: FallbackClockOptions) {
    this.root = document.createElement('section');
    this.root.className = 'fallback';
    this.root.id = 'fallback-view';
    this.root.setAttribute('aria-labelledby', 'fallback-title');
    this.root.hidden = true;

    const title = document.createElement('h2');
    title.className = 'sr-only';
    title.id = 'fallback-title';
    title.textContent = 'Countdown';

    this.countdownEl = document.createElement('p');
    this.countdownEl.className = 'fallback__countdown';
    this.countdownEl.id = 'fallback-countdown';

    this.labelEl = document.createElement('p');
    this.labelEl.className = 'fallback__label';
    this.labelEl.id = 'fallback-label';

    this.noteEl = document.createElement('p');
    this.noteEl.className = 'fallback__note';
    this.noteEl.id = 'fallback-note';
    // Live so the reason for the missing mechanism is heard, not just seen. It
    // changes at most twice in a session, so it cannot compete with the
    // countdown announcer for the speech queue.
    this.noteEl.setAttribute('aria-live', 'polite');

    this.root.append(title, this.countdownEl, this.labelEl, this.noteEl);
    options.container.append(this.root);

    this.unsubscribe = options.store.subscribe((state) => {
      this.render(state);
    });
  }

  get visible(): boolean {
    return !this.root.hidden;
  }

  /** Shows the view, or swaps the note when already shown. */
  show(reason: FallbackReason): void {
    this.root.hidden = false;
    if (this.reason === reason) return;
    this.reason = reason;

    // Deferred by a turn: a live region that already has its text when it is
    // revealed is not reliably announced, because nothing about it changed.
    this.after(() => {
      this.noteEl.textContent = NOTES[reason];
    });
  }

  hide(): void {
    this.root.hidden = true;
    this.reason = null;
    this.noteEl.textContent = '';
  }

  dispose(): void {
    this.unsubscribe();
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
    this.root.remove();
  }

  private render(state: AppState): void {
    const countdown = formatCountdown(state.countdown);
    if (countdown !== this.lastCountdown) {
      this.lastCountdown = countdown;
      this.countdownEl.textContent = countdown;
    }

    const label = state.countdown.elapsed
      ? `since ${state.target.label}`
      : `until ${state.target.label}`;
    if (label !== this.lastLabel) {
      this.lastLabel = label;
      this.labelEl.textContent = label;
    }
  }

  private after(run: () => void): void {
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      run();
    }, 0);
    this.timers.add(timer);
  }
}
