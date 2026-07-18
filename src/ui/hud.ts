/**
 * The 2D shell around the canvas: readout, status strip, settings drawer, toasts.
 *
 * Note what this module does *not* import: three.js. The UI reads the app store
 * and emits intents; the renderer subscribes to the same store. Later UI beads
 * should preserve that boundary.
 *
 * DOM contract for later beads (accessibility, mobile):
 *
 * ```
 * div.hud
 *   div.readout#readout            > p#countdown[role=timer], p#target-label, p.readout__state
 *   div.status#time-status         > span.status__dot, span.status__text
 *   button#settings-toggle[aria-expanded][aria-controls=settings-panel]
 *   section#settings-panel.panel   (see ui/settingsPanel.ts)
 *   div.toast-region[role=status]
 * ```
 *
 * `#countdown` carries the same `formatCountdown` string it always has, so the
 * accessibility bead can mirror it into a live region without reformatting it.
 */

import { LoadingScreen } from './loadingScreen.js';
import { SettingsPanel } from './settingsPanel.js';
import { describeTimeStatus } from './statusText.js';
import { ToastRegion } from './toast.js';
import { formatCountdown } from '../time/countdown.js';
import type { LoadingTracker } from '../app/loading.js';
import type { AppState, AppStore } from '../app/store.js';
import type { SettingControl } from './settings.js';
import type { SettingsPanelOptions } from './settingsPanel.js';

export interface HudOptions extends Pick<
  SettingsPanelOptions,
  'onSubmitTarget' | 'onResetTarget' | 'shareUrl' | 'onCopyLink'
> {
  readonly container: HTMLElement;
  readonly store: AppStore;
  /** Settings controls, in order. See `ui/settings.ts`. */
  readonly controls: readonly SettingControl[];
  readonly viewerZone: string;
  /** Drives the loading screen; omit only in contexts with no boot work. */
  readonly loading?: LoadingTracker;
  /** Emitted when the viewer opens or closes the drawer. */
  readonly onSettingsOpenChange: (open: boolean) => void;
}

export class Hud {
  private readonly root: HTMLDivElement;
  private readonly countdownEl: HTMLParagraphElement;
  private readonly labelEl: HTMLParagraphElement;
  private readonly stateEl: HTMLParagraphElement;
  private readonly statusEl: HTMLDivElement;
  private readonly statusText: HTMLSpanElement;
  private readonly toggle: HTMLButtonElement;
  private readonly panel: SettingsPanel;
  private readonly toasts: ToastRegion;
  private readonly loadingScreen: LoadingScreen | null = null;
  private readonly unsubscribe: () => void;

  private lastCountdown = '';
  private lastLabel = '';
  private lastStatusText = '';
  private lastElapsed: boolean | null = null;
  private lastSettingsOpen: boolean;

  constructor(private readonly options: HudOptions) {
    const { container, store } = options;
    const state = store.get();
    this.lastSettingsOpen = state.settingsOpen;

    this.root = document.createElement('div');
    this.root.className = 'hud';

    // --- readout -----------------------------------------------------------
    const readout = document.createElement('div');
    readout.className = 'readout';
    readout.id = 'readout';

    this.countdownEl = document.createElement('p');
    this.countdownEl.className = 'readout__countdown';
    this.countdownEl.id = 'countdown';
    this.countdownEl.setAttribute('role', 'timer');
    // The accessibility bead owns the live-region mirror; announcing every tick
    // from here would be unbearable.
    this.countdownEl.setAttribute('aria-live', 'off');

    this.labelEl = document.createElement('p');
    this.labelEl.className = 'readout__label';
    this.labelEl.id = 'target-label';

    this.stateEl = document.createElement('p');
    this.stateEl.className = 'readout__state';
    this.stateEl.hidden = true;

    readout.append(this.countdownEl, this.labelEl, this.stateEl);

    // --- clock-accuracy strip ---------------------------------------------
    this.statusEl = document.createElement('div');
    this.statusEl.className = 'status';
    this.statusEl.id = 'time-status';

    const statusDot = document.createElement('span');
    statusDot.className = 'status__dot';
    statusDot.setAttribute('aria-hidden', 'true');

    this.statusText = document.createElement('span');
    this.statusText.className = 'status__text';

    this.statusEl.append(statusDot, this.statusText);

    // --- drawer ------------------------------------------------------------
    this.toggle = document.createElement('button');
    this.toggle.type = 'button';
    this.toggle.id = 'settings-toggle';
    this.toggle.className = 'hud__settings-toggle';
    this.toggle.setAttribute('aria-controls', 'settings-panel');
    this.toggle.setAttribute('aria-expanded', String(state.settingsOpen));
    this.toggle.append(gearIcon(), labelSpan('Settings'));

    this.toasts = new ToastRegion(this.root);

    this.panel = new SettingsPanel({
      store,
      controls: options.controls,
      viewerZone: options.viewerZone,
      onSubmitTarget: options.onSubmitTarget,
      onResetTarget: options.onResetTarget,
      shareUrl: options.shareUrl,
      onCopyLink: async (url) => {
        const copied = await options.onCopyLink(url);
        this.toasts.show(copied ? 'Link copied to the clipboard' : 'Copy the link from the field', {
          tone: copied ? 'ok' : 'error',
        });
        return copied;
      },
      onRequestClose: () => {
        this.options.onSettingsOpenChange(false);
      },
    });

    this.root.append(readout, this.statusEl, this.toggle, this.panel.root);
    container.append(this.root);

    const loadingElement = document.querySelector<HTMLElement>('#loading-screen');
    if (options.loading && loadingElement) {
      this.loadingScreen = new LoadingScreen({
        element: loadingElement,
        tracker: options.loading,
      });
    }

    this.toggle.addEventListener('click', this.onToggleClick);
    document.addEventListener('keydown', this.onKeyDown);

    this.unsubscribe = store.subscribe((next) => {
      this.render(next);
    });
  }

  dispose(): void {
    this.unsubscribe();
    this.toggle.removeEventListener('click', this.onToggleClick);
    document.removeEventListener('keydown', this.onKeyDown);
    this.loadingScreen?.dispose();
    this.panel.dispose();
    this.toasts.dispose();
    this.root.remove();
  }

  // -------------------------------------------------------------------------

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

    if (state.countdown.elapsed !== this.lastElapsed) {
      this.lastElapsed = state.countdown.elapsed;
      this.stateEl.hidden = !state.countdown.elapsed;
      this.stateEl.textContent = state.countdown.elapsed ? 'Time up' : '';
      this.root.classList.toggle('hud--expired', state.countdown.elapsed);
    }

    const status = describeTimeStatus(state.timeStatus, { syncPending: state.syncPending });
    if (status.text !== this.lastStatusText) {
      this.lastStatusText = status.text;
      this.statusText.textContent = status.text;
      this.statusEl.title = status.detail;
      this.statusEl.dataset['level'] = status.level;
      this.statusEl.classList.toggle('status--quiet', status.quiet);
    }

    if (state.settingsOpen !== this.lastSettingsOpen) {
      this.lastSettingsOpen = state.settingsOpen;
      this.toggle.setAttribute('aria-expanded', String(state.settingsOpen));
      this.root.classList.toggle('hud--settings-open', state.settingsOpen);
      // Focus follows the drawer in both directions, so keyboard use is never
      // stranded behind a closed panel. Nothing traps it: Tab always leaves.
      if (state.settingsOpen) this.panel.focusFirstField();
      else this.toggle.focus();
    }
  }

  private readonly onToggleClick = (): void => {
    this.options.onSettingsOpenChange(!this.options.store.get().settingsOpen);
  };

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    if (event.key !== 'Escape') return;
    if (!this.options.store.get().settingsOpen) return;
    // Escape closes the drawer unless a control used it for its own popup (the
    // timezone listbox), which handles the key first and marks it handled.
    if (event.defaultPrevented) return;
    this.options.onSettingsOpenChange(false);
  };
}

/** Inline, so the shell needs no network request to draw its own button. */
function gearIcon(): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('class', 'icon icon--gear');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');

  const teeth = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
  teeth.setAttribute('cx', '12');
  teeth.setAttribute('cy', '12');
  teeth.setAttribute('r', '8');
  teeth.setAttribute('class', 'icon__teeth');

  const hub = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
  hub.setAttribute('cx', '12');
  hub.setAttribute('cy', '12');
  hub.setAttribute('r', '3');
  hub.setAttribute('class', 'icon__hub');

  svg.append(teeth, hub);
  return svg;
}

function labelSpan(text: string): HTMLSpanElement {
  const span = document.createElement('span');
  span.className = 'hud__settings-label';
  span.textContent = text;
  return span;
}
