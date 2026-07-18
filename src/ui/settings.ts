/**
 * Descriptors for the controls in the settings panel.
 *
 * The panel renders whatever list of these it is handed, so adding a setting is
 * a matter of appending one descriptor in `main.ts` — no panel code, no new
 * markup, no styling. That is the extension point for the toggles that are
 * coming (sound, render quality) rather than a comment promising one:
 *
 * ```ts
 * defineToggle({
 *   id: 'sound-toggle',
 *   label: 'Mechanism sound',
 *   read: (state) => state.soundEnabled,
 *   apply: (enabled) => { store.set({ soundEnabled: enabled }); },
 * });
 * ```
 *
 * `read` projects the app state onto the control; `apply` reports the viewer's
 * intent back. Neither touches the DOM, and the panel never writes to the store
 * itself — it calls `apply` and waits for the state to come back round.
 */

import type { AppState } from '../app/store.js';

export interface SettingOption {
  readonly value: string;
  readonly label: string;
  /** Optional longer description, used as the option's `title`. */
  readonly hint?: string;
}

interface SettingBase {
  /** DOM id of the control. Also the stable hook for e2e selectors. */
  readonly id: string;
  readonly label: string;
  /** One line under the control explaining what it does. */
  readonly hint?: string;
}

export interface SelectSetting extends SettingBase {
  readonly kind: 'select';
  readonly options: readonly SettingOption[];
  readonly read: (state: AppState) => string;
  readonly apply: (value: string) => void;
}

export interface ToggleSetting extends SettingBase {
  readonly kind: 'toggle';
  readonly read: (state: AppState) => boolean;
  readonly apply: (value: boolean) => void;
}

export type SettingControl = SelectSetting | ToggleSetting;

export function defineSelect(config: Omit<SelectSetting, 'kind'>): SelectSetting {
  return { kind: 'select', ...config };
}

export function defineToggle(config: Omit<ToggleSetting, 'kind'>): ToggleSetting {
  return { kind: 'toggle', ...config };
}
