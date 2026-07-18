/**
 * The countdown, mirrored into text for assistive technology.
 *
 * ## Why this is not `#countdown`
 *
 * The visible readout carries `role="timer"` and changes four times a second.
 * A `role="timer"` element is an implicit live region, and one that updates
 * that often would make a screen reader recite the clock forever — so the HUD
 * pins it to `aria-live="off"` and the announcements happen here instead, in a
 * separate, visually hidden `aria-live="polite"` element. Exactly one of the
 * two is live; that is the reconciliation.
 *
 * ## Cadence
 *
 * Driven by {@link announcementKey}: once on load, once a minute after that,
 * once each at 60, 30 and 10 seconds, and once at expiry. Slot changes are the
 * only trigger, so the store's push rate is irrelevant — see
 * `ui/countdownSpeech.ts`, where the rule is a pure function with unit tests.
 *
 * The target's label rides along with the first announcement and with the first
 * one after the viewer changes the target, so the duration is never orphaned
 * from what it counts down to.
 */

import { countdownAnnouncement } from './countdownSpeech.js';
import type { AppState, AppStore } from '../app/store.js';

export interface CountdownAnnouncerOptions {
  readonly container: HTMLElement;
  readonly store: AppStore;
}

export class CountdownAnnouncer {
  /** The live region itself. Visually hidden, never removed from the DOM. */
  readonly root: HTMLParagraphElement;

  private readonly unsubscribe: () => void;
  private lastKey: string | null = null;
  private lastTargetLabel: string | null = null;

  constructor(options: CountdownAnnouncerOptions) {
    this.root = document.createElement('p');
    this.root.className = 'sr-only';
    this.root.id = 'countdown-announcement';
    this.root.setAttribute('aria-live', 'polite');
    // The whole sentence is read on every change. Without this a screen reader
    // may announce only the words that differ ("12" rather than "3 hours, 12
    // minutes remaining"), which is meaningless out of context.
    this.root.setAttribute('aria-atomic', 'true');
    options.container.append(this.root);

    this.unsubscribe = options.store.subscribe((state) => {
      this.render(state);
    });
  }

  dispose(): void {
    this.unsubscribe();
    this.root.remove();
  }

  private render(state: AppState): void {
    // Clock mode: announce the reading once whenever the mode or zone takes
    // effect, then stay quiet. A clock that spoke on a countdown's thresholds
    // would be arbitrary, and one that spoke every minute would be unbearable;
    // the always-current figure is one Tab away on the readout itself.
    if (state.clockReading !== null) {
      const key = `clock:${state.target.zone}:${String(state.hours12)}`;
      if (key === this.lastKey) return;
      this.lastKey = key;
      this.root.textContent = `Showing the current time in ${state.target.zone}: ${state.clockReading}.`;
      return;
    }

    // A new target restarts the narration: the next announcement names it, so
    // the change is audible rather than a silently different number.
    const targetChanged = state.target.label !== this.lastTargetLabel;
    if (targetChanged) {
      this.lastTargetLabel = state.target.label;
      this.lastKey = null;
    }

    const withLabel = targetChanged || this.lastKey === null;
    const announcement = countdownAnnouncement(
      state.remaining,
      withLabel ? { label: state.target.label } : {},
    );
    if (announcement.key === this.lastKey) return;

    this.lastKey = announcement.key;
    this.root.textContent = announcement.text;
  }
}
