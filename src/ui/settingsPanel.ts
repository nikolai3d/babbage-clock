/**
 * The settings drawer: target, timezone, scene, lighting mood, share link.
 *
 * Collapsed by default — the clock is the hero — and opened from the brass
 * button in the corner. It reads the app store and emits intents; it never
 * writes to the store, never resolves a target itself and never imports
 * three.js. `main.ts` decides what an intent means and the new state comes back
 * round through the store, so what is on screen is always what the app believes.
 *
 * DOM contract for later beads (accessibility, mobile):
 *
 * ```
 * section#settings-panel.panel[aria-labelledby=settings-title]
 *   header.panel__head        > h2#settings-title, button#settings-close
 *   form#target-form.panel__form
 *     .field > label[for=target-input] + input#target-input[type=datetime-local]
 *     .field > label[for=tz-input]     + .tzpicker(input#tz-input + ul[role=listbox])
 *     p#target-error.field__error[role=alert]
 *     .panel__actions > button[type=submit] + button#target-reset
 *   .echo#target-echo         > dl.echo__rows, p.echo__adjustment, ul.echo__notes
 *   .panel__group             > one .field per SettingControl descriptor
 *   .field--share             > input#share-url[readonly] + button#share-button
 * ```
 */

import { summarizeTarget, toDateTimeLocalValue } from './targetSummary.js';
import { TimeZonePicker } from './timeZonePicker.js';
import type { AppState, AppStore } from '../app/store.js';
import type { ResolvedTarget } from '../time/target.js';
import type { SettingControl } from './settings.js';

/** What the viewer typed into the target form. */
export interface TargetRequest {
  /** Wall-clock value from the date-time control, `YYYY-MM-DDTHH:mm[:ss]`. */
  readonly value: string;
  /** Zone the wall clock is expressed in. */
  readonly zone: string;
}

/** The app's verdict on a `TargetRequest`. */
export type TargetResult = { readonly ok: true } | { readonly ok: false; readonly message: string };

export interface SettingsPanelOptions {
  readonly store: AppStore;
  /** Controls to render, in order. See `ui/settings.ts`. */
  readonly controls: readonly SettingControl[];
  /** Viewer's own zone, used to seed the picker when there is no target zone. */
  readonly viewerZone: string;
  readonly onSubmitTarget: (request: TargetRequest) => TargetResult;
  /** Resets to the default target (the next New Year in the viewer's zone). */
  readonly onResetTarget: () => void;
  /** The shareable URL for the current state, rebuilt whenever state changes. */
  readonly shareUrl: () => string;
  /** Copies the link; resolves false when the clipboard refused. */
  readonly onCopyLink: (url: string) => Promise<boolean>;
  readonly onRequestClose: () => void;
}

export class SettingsPanel {
  readonly root: HTMLElement;

  private readonly form: HTMLFormElement;
  private readonly targetInput: HTMLInputElement;
  private readonly picker: TimeZonePicker;
  private readonly errorEl: HTMLParagraphElement;
  private readonly echoEl: HTMLDivElement;
  private readonly shareInput: HTMLInputElement;
  private readonly closeButton: HTMLButtonElement;
  private readonly resetButton: HTMLButtonElement;
  private readonly shareButton: HTMLButtonElement;
  private readonly controlInputs = new Map<string, HTMLInputElement | HTMLSelectElement>();
  private readonly unsubscribe: () => void;
  private lastTarget: ResolvedTarget | null = null;
  private lastShareKey = '';
  /** True while the viewer is mid-edit, so a store push must not overwrite them. */
  private dirty = false;

  constructor(private readonly options: SettingsPanelOptions) {
    const { store } = options;
    const state = store.get();

    this.root = document.createElement('section');
    this.root.className = 'panel';
    this.root.id = 'settings-panel';
    this.root.setAttribute('aria-labelledby', 'settings-title');
    this.root.hidden = !state.settingsOpen;

    const head = document.createElement('header');
    head.className = 'panel__head';

    const title = document.createElement('h2');
    title.className = 'panel__title';
    title.id = 'settings-title';
    title.textContent = 'Settings';

    this.closeButton = document.createElement('button');
    this.closeButton.type = 'button';
    this.closeButton.id = 'settings-close';
    this.closeButton.className = 'panel__close';
    this.closeButton.setAttribute('aria-label', 'Close settings');
    this.closeButton.textContent = '×';

    head.append(title, this.closeButton);

    // --- target form -------------------------------------------------------
    this.form = document.createElement('form');
    this.form.className = 'panel__form';
    this.form.id = 'target-form';
    this.form.noValidate = true;

    const targetField = document.createElement('div');
    targetField.className = 'field';

    const targetLabel = document.createElement('label');
    targetLabel.className = 'field__label';
    targetLabel.htmlFor = 'target-input';
    targetLabel.textContent = 'Count down to';

    this.targetInput = document.createElement('input');
    this.targetInput.type = 'datetime-local';
    this.targetInput.step = '1';
    this.targetInput.id = 'target-input';
    this.targetInput.className = 'field__input';
    this.targetInput.value = toDateTimeLocalValue(state.target);

    targetField.append(targetLabel, this.targetInput);

    const zoneField = document.createElement('div');
    zoneField.className = 'field';

    const zoneLabel = document.createElement('label');
    zoneLabel.className = 'field__label';
    zoneLabel.htmlFor = 'tz-input';
    zoneLabel.textContent = 'Time zone';

    this.picker = new TimeZonePicker({
      inputId: 'tz-input',
      initialZone: state.target.zone || options.viewerZone,
      referenceMs: state.target.atMs,
      onChange: () => {
        this.dirty = true;
      },
    });

    const zoneHint = document.createElement('p');
    zoneHint.className = 'field__hint';
    zoneHint.id = 'tz-hint';
    zoneHint.textContent = 'The zone your date and time are written in.';
    this.picker.input.setAttribute('aria-describedby', zoneHint.id);

    zoneField.append(zoneLabel, this.picker.root, zoneHint);

    this.errorEl = document.createElement('p');
    this.errorEl.className = 'field__error';
    this.errorEl.id = 'target-error';
    this.errorEl.setAttribute('role', 'alert');
    this.errorEl.hidden = true;

    const actions = document.createElement('div');
    actions.className = 'panel__actions';

    const submit = document.createElement('button');
    submit.type = 'submit';
    submit.className = 'button button--primary';
    submit.id = 'target-apply';
    submit.textContent = 'Set target';

    this.resetButton = document.createElement('button');
    this.resetButton.type = 'button';
    this.resetButton.className = 'button';
    this.resetButton.id = 'target-reset';
    this.resetButton.textContent = 'Use default';

    actions.append(submit, this.resetButton);
    this.form.append(targetField, zoneField, this.errorEl, actions);

    // --- resolved-target echo ---------------------------------------------
    this.echoEl = document.createElement('div');
    this.echoEl.className = 'echo';
    this.echoEl.id = 'target-echo';

    // --- descriptor-driven controls ---------------------------------------
    const controlGroup = document.createElement('div');
    controlGroup.className = 'panel__group';
    for (const control of options.controls) {
      controlGroup.append(this.renderControl(control));
    }

    // --- share -------------------------------------------------------------
    const shareField = document.createElement('div');
    shareField.className = 'field field--share';

    const shareLabel = document.createElement('label');
    shareLabel.className = 'field__label';
    shareLabel.htmlFor = 'share-url';
    shareLabel.textContent = 'Shareable link';

    const shareRow = document.createElement('div');
    shareRow.className = 'field__row';

    this.shareInput = document.createElement('input');
    this.shareInput.type = 'text';
    this.shareInput.id = 'share-url';
    this.shareInput.className = 'field__input';
    this.shareInput.readOnly = true;

    this.shareButton = document.createElement('button');
    this.shareButton.type = 'button';
    this.shareButton.id = 'share-button';
    this.shareButton.className = 'button button--primary';
    this.shareButton.textContent = 'Copy link';

    shareRow.append(this.shareInput, this.shareButton);
    shareField.append(shareLabel, shareRow);

    this.root.append(head, this.form, this.echoEl, controlGroup, shareField);

    this.closeButton.addEventListener('click', this.onClose);
    this.resetButton.addEventListener('click', this.onReset);
    this.shareButton.addEventListener('click', this.onCopy);
    this.form.addEventListener('submit', this.onSubmit);
    this.targetInput.addEventListener('input', this.onFieldEdited);

    this.unsubscribe = store.subscribe((next) => {
      this.render(next);
    });
  }

  /** Moves focus to the first control — called after the drawer opens. */
  focusFirstField(): void {
    this.targetInput.focus();
  }

  dispose(): void {
    this.unsubscribe();
    this.closeButton.removeEventListener('click', this.onClose);
    this.resetButton.removeEventListener('click', this.onReset);
    this.shareButton.removeEventListener('click', this.onCopy);
    this.form.removeEventListener('submit', this.onSubmit);
    this.targetInput.removeEventListener('input', this.onFieldEdited);
    // The descriptor controls' listeners are closures held only by their own
    // detached elements, so dropping the map is enough to make them collectable.
    this.controlInputs.clear();
    this.picker.dispose();
    this.root.remove();
  }

  // -------------------------------------------------------------------------

  private render(state: AppState): void {
    this.root.hidden = !state.settingsOpen;

    // Abandoning an edit by closing the drawer discards it: reopening should
    // show what the clock is actually counting down to, not a stale draft.
    if (!state.settingsOpen && this.dirty) {
      this.dirty = false;
      this.fillTargetFields(state.target);
    }

    if (state.target !== this.lastTarget) {
      this.lastTarget = state.target;
      if (!this.dirty) this.fillTargetFields(state.target);
      this.renderEcho(state.target);
      this.setError(null);
    }

    // Rebuilt only when something the link encodes has changed; this runs on
    // every countdown tick.
    const shareKey = `${state.sceneId}|${state.mood ?? ''}|${String(state.target.atMs)}|${state.target.zone}`;
    if (shareKey !== this.lastShareKey) {
      this.lastShareKey = shareKey;
      this.shareInput.value = this.options.shareUrl();
    }

    for (const control of this.options.controls) {
      const input = this.controlInputs.get(control.id);
      if (!input) continue;
      if (control.kind === 'select' && input instanceof HTMLSelectElement) {
        const value = control.read(state);
        if (input.value !== value) input.value = value;
      } else if (control.kind === 'toggle' && input instanceof HTMLInputElement) {
        const value = control.read(state);
        if (input.checked !== value) input.checked = value;
      }
    }
  }

  private fillTargetFields(target: ResolvedTarget): void {
    const value = toDateTimeLocalValue(target);
    if (this.targetInput.value !== value) this.targetInput.value = value;
    if (this.picker.value !== target.zone) this.picker.value = target.zone;
  }

  private renderEcho(target: ResolvedTarget): void {
    const summary = summarizeTarget(target);
    const rows = document.createElement('dl');
    rows.className = 'echo__rows';

    for (const line of [summary.entered, summary.viewer]) {
      if (!line) continue;
      const row = document.createElement('div');
      row.className = 'echo__row';

      const term = document.createElement('dt');
      term.className = 'echo__term';
      term.textContent = line.caption;

      const value = document.createElement('dd');
      value.className = 'echo__value';

      const clock = document.createElement('span');
      clock.className = 'echo__clock';
      clock.textContent = line.wallClock;

      const zone = document.createElement('span');
      zone.className = 'echo__zone';
      zone.textContent = `${line.offset} ${line.zone}`;

      value.append(clock, zone);
      row.append(term, value);
      rows.append(row);
    }

    const children: HTMLElement[] = [rows];

    if (summary.expired) {
      const expired = document.createElement('p');
      expired.className = 'echo__expired';
      expired.textContent = 'This moment has already passed — the clock is counting up.';
      children.push(expired);
    }

    if (summary.adjustment) {
      const adjustment = document.createElement('p');
      adjustment.className = 'echo__adjustment';
      adjustment.textContent = summary.adjustment;
      children.push(adjustment);
    }

    if (summary.notes.length > 0) {
      const notes = document.createElement('ul');
      notes.className = 'echo__notes';
      for (const note of summary.notes) {
        const item = document.createElement('li');
        item.className = 'echo__note';
        item.textContent = note;
        notes.append(item);
      }
      children.push(notes);
    }

    const origin = document.createElement('p');
    origin.className = 'echo__origin';
    origin.textContent = summary.origin;
    children.push(origin);

    this.echoEl.replaceChildren(...children);
  }

  private renderControl(control: SettingControl): HTMLElement {
    const field = document.createElement('div');
    field.className = 'field';

    const label = document.createElement('label');
    label.className = 'field__label';
    label.htmlFor = control.id;
    label.textContent = control.label;

    let input: HTMLInputElement | HTMLSelectElement;
    if (control.kind === 'select') {
      const select = document.createElement('select');
      select.id = control.id;
      select.className = 'field__input field__select';
      for (const option of control.options) {
        const element = document.createElement('option');
        element.value = option.value;
        element.textContent = option.label;
        if (option.hint) element.title = option.hint;
        select.append(element);
      }
      select.value = control.read(this.options.store.get());
      select.addEventListener('change', () => {
        control.apply(select.value);
      });
      input = select;
      field.append(label, select);
    } else {
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.id = control.id;
      checkbox.className = 'field__checkbox';
      checkbox.checked = control.read(this.options.store.get());
      checkbox.addEventListener('change', () => {
        control.apply(checkbox.checked);
      });
      input = checkbox;
      field.classList.add('field--toggle');
      field.append(checkbox, label);
    }

    if (control.hint) {
      const hint = document.createElement('p');
      hint.className = 'field__hint';
      hint.id = `${control.id}-hint`;
      hint.textContent = control.hint;
      input.setAttribute('aria-describedby', hint.id);
      field.append(hint);
    }

    this.controlInputs.set(control.id, input);
    return field;
  }

  private readonly onFieldEdited = (): void => {
    this.dirty = true;
  };

  private readonly onSubmit = (event: SubmitEvent): void => {
    event.preventDefault();
    const value = this.targetInput.value.trim();
    if (value === '') {
      this.setError('Pick a date and time first.');
      return;
    }

    const result = this.options.onSubmitTarget({ value, zone: this.picker.value });
    if (result.ok) {
      this.dirty = false;
      this.setError(null);
    } else {
      this.setError(result.message);
    }
  };

  private readonly onReset = (): void => {
    this.dirty = false;
    this.options.onResetTarget();
  };

  private readonly onClose = (): void => {
    this.options.onRequestClose();
  };

  private readonly onCopy = (): void => {
    void this.options.onCopyLink(this.shareInput.value).then((copied) => {
      if (copied) return;
      // Clipboard access can be refused outright (insecure context, denied
      // permission). Selecting the field leaves the viewer one keystroke away.
      this.shareInput.focus();
      this.shareInput.select();
    });
  };

  private setError(message: string | null): void {
    this.errorEl.textContent = message ?? '';
    this.errorEl.hidden = message === null;
    this.targetInput.setAttribute('aria-invalid', String(message !== null));
  }
}
