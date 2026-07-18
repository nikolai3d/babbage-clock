import { Store } from './app/store.js';
import { readLaunchParams, writeSceneParam } from './app/urlParams.js';
import { ClockRenderer } from './render/renderer.js';
import { sceneRegistry } from './scene/scenes/index.js';
import { computeCountdown } from './time/countdown.js';
import { resolveTargetFromParams } from './time/target.js';
import {
  disposeTrueTime,
  getTimeStatus,
  getTrueTimeClock,
  trueTimeSource,
} from './time/trueTime.js';
import { Hud } from './ui/hud.js';
import type { AppState } from './app/store.js';
import './styles.css';

/**
 * Application bootstrap: read the URL, build the store, wire renderer and UI.
 *
 * Kept small on purpose — the interesting decisions live in the scene registry
 * (what to draw), `render/` (how to draw it) and `time/` (what it reads out).
 */
function bootstrap(): void {
  const canvas = document.querySelector<HTMLCanvasElement>('#scene-canvas');
  const uiRoot = document.querySelector<HTMLElement>('#ui-root');
  if (!canvas || !uiRoot) throw new Error('Expected #scene-canvas and #ui-root in the document');

  const params = readLaunchParams(window.location.search);
  // The corrected clock: monotonic in-session and skew-checked against the
  // network. It reports the device clock immediately and improves in place
  // once the first sync lands, so nothing here has to wait on the network.
  const timeSource = trueTimeSource;
  const nowMs = timeSource.now();

  const target = resolveTargetFromParams({ target: params.target, tz: params.tz }, nowMs);
  const sceneId = sceneRegistry.resolveId(params.sceneId);

  const store = new Store<AppState>({
    sceneId,
    target,
    countdown: computeCountdown(target.atMs, nowMs),
    timeStatus: getTimeStatus(),
    hidden: document.hidden,
    fps: 0,
  });

  const unsubscribeTime = getTrueTimeClock().subscribe((timeStatus) => {
    store.set({ timeStatus });
  });
  // Fire and forget: a failed sync degrades the accuracy tier, never the view.
  void getTrueTimeClock()
    .init()
    .catch(() => undefined);

  const renderer = new ClockRenderer({ canvas, store, timeSource });
  renderer.setScene(sceneRegistry.resolve(sceneId));

  const hud = new Hud({
    container: uiRoot,
    store,
    scenes: sceneRegistry.list(),
    onSelectScene: (nextId) => {
      const definition = sceneRegistry.get(nextId);
      if (!definition || definition.id === store.get().sceneId) return;
      renderer.setScene(definition);
      store.set({ sceneId: definition.id });
      writeSceneParam(definition.id);
    },
  });

  renderer.start();

  // Vite HMR: without this the old WebGL context and its listeners survive every
  // edit, and the tab dies after a handful of saves.
  if (import.meta.hot) {
    import.meta.hot.dispose(() => {
      hud.dispose();
      renderer.dispose();
      store.dispose();
      unsubscribeTime();
      disposeTrueTime();
    });
  }
}

bootstrap();
