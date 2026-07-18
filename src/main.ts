import { LoadingTracker } from './app/loading.js';
import { Store } from './app/store.js';
import { buildShareUrl, readLaunchParams, writeAppParams } from './app/urlParams.js';
import { ClockRenderer } from './render/renderer.js';
import {
  ENVIRONMENT_PRESETS,
  parseEnvironmentPreset,
  withEnvironmentPreset,
} from './scene/environment.js';
import { sceneRegistry } from './scene/scenes/index.js';
import { computeCountdown } from './time/countdown.js';
import {
  TargetError,
  defaultTarget,
  resolveTarget,
  resolveTargetFromParams,
  viewerTimeZone,
} from './time/target.js';
import {
  disposeTrueTime,
  getTimeStatus,
  getTrueTimeClock,
  trueTimeSource,
} from './time/trueTime.js';
import { Hud } from './ui/hud.js';
import { defineSelect } from './ui/settings.js';
import type { AppState } from './app/store.js';
import type { ShareableState } from './app/urlParams.js';
import type { SettingControl } from './ui/settings.js';
import './styles.css';

/**
 * Application bootstrap: read the URL, build the store, wire renderer and UI.
 *
 * Kept small on purpose — the interesting decisions live in the scene registry
 * (what to draw), `render/` (how to draw it), `time/` (what it reads out) and
 * `ui/` (how it is presented). This module is where UI intents become state
 * changes, because it is the only place that knows about all four.
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
  const viewerZone = viewerTimeZone();

  const target = resolveTargetFromParams({ target: params.target, tz: params.tz }, nowMs);
  const sceneId = sceneRegistry.resolveId(params.sceneId);

  const store = new Store<AppState>({
    sceneId,
    mood: params.mood,
    target,
    countdown: computeCountdown(target.atMs, nowMs),
    timeStatus: getTimeStatus(),
    syncPending: true,
    settingsOpen: false,
    hidden: document.hidden,
    fps: 0,
  });

  // Real boot progress for the loading screen. The texture and HDRI beads add
  // their own tasks here and report against them; see `app/loading.ts`.
  const loading = new LoadingTracker();
  const sceneTask = loading.task('scene', { label: 'Assembling the mechanism', weight: 2 });
  const clockTask = loading.task('time-sync', { label: 'Checking world time', weight: 1 });

  const unsubscribeTime = getTrueTimeClock().subscribe((timeStatus) => {
    store.set({ timeStatus });
  });
  // Fire and forget: a failed sync degrades the accuracy tier, never the view.
  void getTrueTimeClock()
    .init()
    .catch(() => undefined)
    .finally(() => {
      store.set({ syncPending: false });
      clockTask.done();
    });

  const renderer = new ClockRenderer({ canvas, store, timeSource });

  /** Rebuilds the three.js scene for the current scene id and lighting mood. */
  const applyScene = (): void => {
    const state = store.get();
    renderer.setScene(withEnvironmentPreset(sceneRegistry.resolve(state.sceneId), state.mood));
  };

  const shareState = (): ShareableState => {
    const state = store.get();
    return { sceneId: state.sceneId, target: state.target, mood: state.mood };
  };

  applyScene();

  const controls: readonly SettingControl[] = [
    defineSelect({
      id: 'scene-select',
      label: 'Scene',
      options: sceneRegistry.list().map((scene) => ({
        value: scene.id,
        label: scene.name,
        hint: scene.description,
      })),
      read: (state) => state.sceneId,
      apply: (value) => {
        const definition = sceneRegistry.get(value);
        if (!definition || definition.id === store.get().sceneId) return;
        store.set({ sceneId: definition.id });
        applyScene();
        writeAppParams(shareState());
      },
    }),
    defineSelect({
      id: 'mood-select',
      label: 'Lighting mood',
      hint: 'Image-based lighting is not implemented yet, so this has no visible effect.',
      options: [
        { value: '', label: 'Scene default' },
        ...ENVIRONMENT_PRESETS.map((preset) => ({
          value: preset.id,
          label: preset.name,
          hint: preset.description,
        })),
      ],
      read: (state) => state.mood ?? '',
      apply: (value) => {
        const mood = parseEnvironmentPreset(value);
        if (mood === store.get().mood) return;
        store.set({ mood });
        applyScene();
        writeAppParams(shareState());
      },
    }),
  ];

  const hud = new Hud({
    container: uiRoot,
    store,
    controls,
    viewerZone,
    loading,
    onSettingsOpenChange: (open) => {
      store.set({ settingsOpen: open });
    },
    onSubmitTarget: ({ value, zone }) => {
      try {
        const next = resolveTarget({
          value,
          zone,
          source: 'input',
          nowMs: timeSource.now(),
          viewerZone,
        });
        store.set({ target: next });
        writeAppParams(shareState());
        return { ok: true };
      } catch (error) {
        // `resolveTarget` throws only `TargetError`, whose message is already
        // written for a human; anything else is a bug worth showing plainly.
        const message =
          error instanceof TargetError
            ? error.message
            : 'That date and time could not be understood.';
        return { ok: false, message };
      }
    },
    onResetTarget: () => {
      store.set({ target: defaultTarget(timeSource.now(), viewerZone) });
      writeAppParams(shareState());
    },
    shareUrl: () => buildShareUrl(window.location.href, shareState()),
    onCopyLink: copyToClipboard,
  });

  renderer.start();
  sceneTask.done();

  if (import.meta.env.DEV) {
    // Dev only. A static import would ship the diagnostics overlay to
    // production; this branch is folded away in a production build.
    void import('./ui/debugPanel.js').then(({ DebugPanel }) => new DebugPanel(uiRoot, store));
  }

  // Vite HMR: without this the old WebGL context and its listeners survive every
  // edit, and the tab dies after a handful of saves.
  if (import.meta.hot) {
    import.meta.hot.dispose(() => {
      hud.dispose();
      renderer.dispose();
      store.dispose();
      loading.dispose();
      unsubscribeTime();
      disposeTrueTime();
    });
  }
}

/** Clipboard write that reports refusal rather than throwing. */
async function copyToClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Insecure context, denied permission, or no clipboard at all. The panel
    // falls back to selecting the link for a manual copy.
    return false;
  }
}

bootstrap();
