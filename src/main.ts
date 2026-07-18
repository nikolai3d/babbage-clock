import { CountdownTicker } from './app/countdownTicker.js';
import { LoadingTracker } from './app/loading.js';
import { MotionPreference } from './app/motion.js';
import {
  parseQualityPreference,
  qualitySettings,
  readDeviceProfile,
  resolveQualityTier,
} from './app/quality.js';
import { Store } from './app/store.js';
import {
  installTestApi,
  presentationTimeStatus,
  readTestHooks,
  resolveTimeSource,
} from './app/testHooks.js';
import { buildShareUrl, readLaunchParams, writeAppParams } from './app/urlParams.js';
import type { ClockRenderer } from './render/renderer.js';
import {
  ENVIRONMENT_PRESETS,
  parseEnvironmentPreset,
  withEnvironmentPreset,
} from './scene/environment.js';
import { sceneRegistry } from './scene/scenes/index.js';
import { computeCountdown, computeRemaining } from './time/countdown.js';
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
import { FallbackClock } from './ui/fallbackClock.js';
import { Hud } from './ui/hud.js';
import { defineSelect } from './ui/settings.js';
import type { AppState } from './app/store.js';
import type { RendererProbe } from './app/testHooks.js';
import type { ShareableState } from './app/urlParams.js';
import type { FallbackReason } from './ui/fallbackClock.js';
import type { SettingControl } from './ui/settings.js';
import './styles.css';

/**
 * How long to wait for a lost WebGL context before calling it permanent.
 *
 * Browsers restore a context asynchronously and give no signal that they have
 * given up, so the only honest options are "wait forever" or a deadline. The
 * fallback countdown is already correct and on screen either way; this only
 * decides when the note stops saying "waiting".
 */
const CONTEXT_RESTORE_GRACE_MS = 8_000;

/**
 * Application bootstrap: read the URL, build the store, wire renderer and UI.
 *
 * Kept small on purpose — the interesting decisions live in the scene registry
 * (what to draw), `render/` (how to draw it), `time/` (what it reads out) and
 * `ui/` (how it is presented). This module is where UI intents become state
 * changes, because it is the only place that knows about all four.
 */
async function bootstrap(): Promise<void> {
  const canvas = document.querySelector<HTMLCanvasElement>('#scene-canvas');
  const uiRoot = document.querySelector<HTMLElement>('#ui-root');
  if (!canvas || !uiRoot) throw new Error('Expected #scene-canvas and #ui-root in the document');

  const params = readLaunchParams(window.location.search);
  // Test hooks are inert unless their query parameters are present: with none
  // of them set this is exactly `trueTimeSource`, motion on, no global API.
  const hooks = readTestHooks(window.location.search);
  // The corrected clock: monotonic in-session and skew-checked against the
  // network. It reports the device clock immediately and improves in place
  // once the first sync lands, so nothing here has to wait on the network.
  // `?mockNow=` replaces it wholesale; without that parameter this is exactly
  // `trueTimeSource`.
  const timeSource = resolveTimeSource(hooks, trueTimeSource);
  // Floor is load-bearing, not tidiness. `trueTimeSource.now()` is
  // `baseEpochMs + (performance.now() - baseMark)`, which is fractional
  // whenever those monotonic marks do not differ by a whole millisecond. The
  // Temporal-backed target resolution below takes epoch *integers* and throws
  // `Expected finite integer` on a fraction — which killed bootstrap outright,
  // leaving a blank page with the canvas present and no UI. It reproduced on
  // roughly 3% of loads, so it read as flakiness rather than a bug.
  //
  // The durable fix belongs in `src/time/trueTime.ts` (epoch milliseconds
  // should be integral at the source); this satisfies the contract at the call
  // site until then. See the follow-up bead.
  const nowMs = Math.floor(timeSource.now());
  const viewerZone = viewerTimeZone();

  const target = resolveTargetFromParams({ target: params.target, tz: params.tz }, nowMs);
  const sceneId = sceneRegistry.resolveId(params.sceneId);

  // How hard this device may be pushed. `auto` consults the heuristic; the
  // viewer can override it in the drawer at any time, and `?quality=` pins it.
  const deviceProfile = readDeviceProfile();
  const qualityTier = resolveQualityTier(params.quality, deviceProfile);

  const store = new Store<AppState>({
    sceneId,
    mood: params.mood,
    quality: params.quality,
    qualityTier,
    target,
    countdown: computeCountdown(target.atMs, nowMs),
    remaining: computeRemaining(target.atMs, nowMs),
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
  //
  // Skipped when the clock is pinned (correcting a deliberately frozen clock is
  // contradictory, and it would make a deterministic capture depend on an
  // external service) or when `?nosync` asks for a hermetic run. Neither
  // parameter is set in production, so the sync is the normal path.
  //
  // The pending state and the loading task still have to be settled either way,
  // or the loading screen would wait forever on a sync that is never coming.
  if (hooks.mockNowMs === null && hooks.timeSync) {
    void getTrueTimeClock()
      .init()
      .catch(() => undefined)
      .finally(() => {
        store.set({ syncPending: false });
        clockTask.done();
      });
  } else {
    // A hermetic run never syncs, so the strip would honestly warn about the
    // device clock in every capture. `?mocksync` presents a healthy synced
    // status instead — presentation only; the clock stays hermetic.
    if (hooks.mockSync) {
      store.set({ timeStatus: presentationTimeStatus(timeSource.now()), syncPending: false });
    } else {
      store.set({ syncPending: false });
    }
    clockTask.done();
  }

  // The one motion switch: `prefers-reduced-motion` and `?nomotion=1` combined
  // into a single value, kept current if the viewer changes the setting.
  const motionPreference = new MotionPreference(hooks.motion);
  // Advances the countdown whenever the render loop is not there to do it —
  // no WebGL at all, or a context that has been taken away. Idle otherwise.
  const ticker = new CountdownTicker({ store, timeSource });
  const fallback = new FallbackClock({ container: uiRoot, store });
  let restoreTimer: ReturnType<typeof setTimeout> | null = null;

  /** Text countdown in, mechanism out. Safe to call repeatedly. */
  function enterFallback(reason: FallbackReason): void {
    hud.setReadoutVisible(false);
    fallback.show(reason);
    ticker.start();
  }

  /** Mechanism back, text countdown out. */
  function leaveFallback(): void {
    if (restoreTimer !== null) {
      clearTimeout(restoreTimer);
      restoreTimer = null;
    }
    ticker.stop();
    fallback.hide();
    hud.setReadoutVisible(true);
    // A restored context comes back at the browser's defaults: it has forgotten
    // the pixel ratio the quality tier chose and the framing derived for this
    // viewport. Re-assert both before the first frame is drawn on it.
    renderer?.refresh();
  }

  // A browser with no WebGL must not take the countdown down with it:
  // everything below this point works with `renderer === null`, and the
  // fallback view runs off the same store.
  //
  // The render layer — and three.js inside it, the biggest thing this app
  // ships — is a dynamic import behind a WebGL2 probe. A client that cannot
  // render never downloads a renderer: the probe uses a throwaway canvas (the
  // real one must meet three.js with no context attached), and a null probe
  // skips the fetch entirely rather than downloading half a megabyte to watch
  // its constructor throw. The countdown works either way; three.js parse and
  // fetch no longer sit in front of the readout on any path.
  let renderer: ClockRenderer | null = null;
  const probeContext = document.createElement('canvas').getContext('webgl2');
  try {
    if (probeContext === null) throw new Error('WebGL2 probe returned null');
    const { ClockRenderer } = await import('./render/renderer.js');
    renderer = new ClockRenderer({
      canvas,
      store,
      timeSource,
      motion: motionPreference.enabled,
      quality: qualitySettings(qualityTier),
      onContextLost: () => {
        enterFallback('context-lost');
        // A second loss before the first restore must not leave the first
        // deadline running: it would declare the context permanently gone while
        // the browser is still trying to bring the new one back.
        if (restoreTimer !== null) clearTimeout(restoreTimer);
        restoreTimer = setTimeout(() => {
          restoreTimer = null;
          fallback.show('context-lost-permanent');
        }, CONTEXT_RESTORE_GRACE_MS);
      },
      onContextRestored: leaveFallback,
    });
  } catch (error) {
    console.warn('[main] WebGL is unavailable — showing the text countdown instead.', error);
  }

  const unsubscribeMotion = motionPreference.subscribe((enabled) => {
    renderer?.setMotion(enabled);
  });

  /** Rebuilds the three.js scene for the current scene id and lighting mood. */
  const applyScene = (): void => {
    const state = store.get();
    renderer?.setScene(withEnvironmentPreset(sceneRegistry.resolve(state.sceneId), state.mood));
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
      hint: 'Swaps the environment map, light rig and grade. Independent of the scene.',
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
    defineSelect({
      id: 'quality-select',
      label: 'Render quality',
      hint: 'Automatic follows the device. Lower caps resolution and frame rate, and draws a plain backdrop.',
      options: [
        { value: 'auto', label: 'Automatic', hint: 'Chosen from screen, cores and pointer type.' },
        {
          value: 'high',
          label: 'Higher',
          hint: 'Full resolution, panorama backdrop, uncapped frames.',
        },
        { value: 'low', label: 'Lower', hint: 'Kinder to a phone battery and a warm laptop.' },
      ],
      read: (state) => state.quality,
      apply: (value) => {
        const preference = parseQualityPreference(value);
        if (preference === store.get().quality) return;
        // Re-read the device: the viewer may have rotated the phone or moved
        // the window to another display since boot, and `auto` should answer
        // for the machine as it is now.
        const tier = resolveQualityTier(preference, readDeviceProfile());
        store.set({ quality: preference, qualityTier: tier });
        // Live, not on reload: everything a tier controls is re-derivable.
        renderer?.setQuality(qualitySettings(tier));
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

  if (renderer) {
    renderer.start();
  } else {
    // The canvas is inert without a context; leaving it in the document would
    // put an unlabelled tab stop in front of the countdown.
    canvas.hidden = true;
    enterFallback('no-webgl');
  }
  sceneTask.done();

  if (import.meta.env.DEV) {
    // Dev only. A static import would ship the diagnostics overlay to
    // production; this branch is folded away in a production build.
    void import('./ui/debugPanel.js').then(({ DebugPanel }) => new DebugPanel(uiRoot, store));
  }

  // Without a renderer there is still state worth observing, so the probe
  // reports an honest "nothing is being drawn" rather than being absent — that
  // is what lets the no-WebGL e2e spec assert on the fallback.
  const rendererProbe: RendererProbe = renderer ?? {
    getDigits: () => [],
    getRenderState: () => ({
      webgl2: false,
      frames: 0,
      fps: 0,
      running: false,
      drawCalls: 0,
      triangles: 0,
      width: 0,
      height: 0,
      pixelRatio: 1,
      motion: motionPreference.enabled,
      contextLost: true,
      cameraPosition: [0, 0, 0],
      sceneId: null,
      // No scene was ever built, so no environment map was ever asked for.
      lighting: 'none',
      // The tier was still chosen — it describes the device, not the context —
      // but nothing is being framed or drawn against it.
      quality: qualityTier,
      maxFps: qualitySettings(qualityTier).maxFps,
      framingFit: 'whole',
      ringExtentPx: 0,
    }),
  };
  const uninstallTestApi = installTestApi(hooks, {
    store,
    renderer: rendererProbe,
    timeSource,
  });

  // Vite HMR: without this the old WebGL context and its listeners survive every
  // edit, and the tab dies after a handful of saves.
  if (import.meta.hot) {
    import.meta.hot.dispose(() => {
      uninstallTestApi();
      if (restoreTimer !== null) clearTimeout(restoreTimer);
      unsubscribeMotion();
      motionPreference.dispose();
      ticker.dispose();
      fallback.dispose();
      hud.dispose();
      renderer?.dispose();
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

bootstrap().catch((error: unknown) => {
  // A failed bootstrap leaves a blank page with no signal otherwise. There is
  // no UI to fall back to at this point, so the console is the honest option.
  console.error('[main] bootstrap failed', error);
  throw error;
});
