import { formatCountdown } from '../time/countdown.js';
import type { AppStore } from '../app/store.js';
import type { SceneDefinition } from '../scene/types.js';

export interface HudOptions {
  readonly container: HTMLElement;
  readonly store: AppStore;
  readonly scenes: readonly SceneDefinition[];
  /** Called when the viewer picks a scene; the app decides what that means. */
  readonly onSelectScene: (sceneId: string) => void;
}

/**
 * The minimal on-screen readout and scene picker.
 *
 * Note what this module does *not* import: three.js. The UI reads the app store
 * and emits intents; the renderer subscribes to the same store. Later UI beads
 * should preserve that boundary.
 */
export class Hud {
  private readonly root: HTMLDivElement;
  private readonly countdownEl: HTMLParagraphElement;
  private readonly targetEl: HTMLParagraphElement;
  private readonly select: HTMLSelectElement;
  private readonly unsubscribe: () => void;

  constructor(private readonly options: HudOptions) {
    const { container, store, scenes } = options;

    this.root = document.createElement('div');
    this.root.className = 'hud';

    const readout = document.createElement('div');
    readout.className = 'hud__readout';

    this.countdownEl = document.createElement('p');
    this.countdownEl.className = 'hud__countdown';
    this.countdownEl.setAttribute('role', 'timer');
    this.countdownEl.setAttribute('aria-live', 'off');

    this.targetEl = document.createElement('p');
    this.targetEl.className = 'hud__target';

    readout.append(this.countdownEl, this.targetEl);

    const controls = document.createElement('div');
    controls.className = 'hud__controls';

    const label = document.createElement('label');
    label.className = 'hud__label';
    label.htmlFor = 'scene-select';
    label.textContent = 'Scene';

    this.select = document.createElement('select');
    this.select.id = 'scene-select';
    this.select.className = 'hud__select';
    for (const scene of scenes) {
      const option = document.createElement('option');
      option.value = scene.id;
      option.textContent = scene.name;
      option.title = scene.description;
      this.select.append(option);
    }
    this.select.addEventListener('change', this.onSelectChange);

    controls.append(label, this.select);
    this.root.append(readout, controls);
    container.append(this.root);

    this.unsubscribe = store.subscribe((state) => {
      this.countdownEl.textContent = formatCountdown(state.countdown);
      this.targetEl.textContent = state.countdown.elapsed
        ? `since ${state.target.label}`
        : `until ${state.target.label}`;
      if (this.select.value !== state.sceneId) this.select.value = state.sceneId;
    });
  }

  private readonly onSelectChange = (): void => {
    this.options.onSelectScene(this.select.value);
  };

  dispose(): void {
    this.unsubscribe();
    this.select.removeEventListener('change', this.onSelectChange);
    this.root.remove();
  }
}
