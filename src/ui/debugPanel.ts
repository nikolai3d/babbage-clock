/**
 * Development-only diagnostics overlay: fps, tab visibility, clock tier.
 *
 * Kept out of the shipped bundle rather than merely hidden: `main.ts` imports
 * it dynamically behind `import.meta.env.DEV`, which Vite folds to `false` in a
 * production build, so the whole chunk is dropped. Nothing else may import it
 * statically or that guarantee is gone.
 */

import { formatDuration } from './statusText.js';
import type { AppState, AppStore } from '../app/store.js';

export class DebugPanel {
  private readonly root: HTMLDivElement;
  private readonly unsubscribe: () => void;

  constructor(container: HTMLElement, store: AppStore) {
    this.root = document.createElement('div');
    this.root.className = 'debug-panel';
    this.root.id = 'debug-panel';
    container.append(this.root);

    this.unsubscribe = store.subscribe((state) => {
      this.root.textContent = describe(state);
    });
  }

  dispose(): void {
    this.unsubscribe();
    this.root.remove();
  }
}

function describe(state: AppState): string {
  const { timeStatus } = state;
  const parts = [
    `${String(state.fps)} fps`,
    state.hidden ? 'hidden' : 'visible',
    `${timeStatus.tier}${timeStatus.sourceId ? ` (${timeStatus.sourceId})` : ''}`,
    `offset ${formatDuration(timeStatus.offsetMs)}`,
    `± ${formatDuration(timeStatus.uncertaintyMs)}`,
    `${String(timeStatus.sampleCount)} samples`,
    state.sceneId,
    state.mood ?? 'scene mood',
  ];
  return parts.join(' · ');
}
