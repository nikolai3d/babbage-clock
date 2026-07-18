import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { ClockSceneView } from './clockScene.js';
import { computeCountdown, computeRemaining } from '../time/countdown.js';
import { clockFrame, countdownFrame } from '../mechanism/index.js';
import type { AppStore } from '../app/store.js';
import type { SceneDefinition } from '../scene/types.js';
import type { RemainingTime } from '../time/countdown.js';
import type { TimeSource } from '../time/target.js';

/** Retina displays gain little above 2x and cost a lot of fill rate. */
const MAX_PIXEL_RATIO = 2;
/** Clamp for the frame delta so a stalled frame does not spike the fps readout. */
const MAX_FRAME_DELTA_SECONDS = 0.1;
const FPS_SMOOTHING = 0.1;
const STORE_UPDATE_INTERVAL_MS = 250;

export interface ClockRendererOptions {
  readonly canvas: HTMLCanvasElement;
  readonly store: AppStore;
  readonly timeSource: TimeSource;
  /**
   * When false, every time-varying flourish is switched off: OrbitControls
   * damping, the tick easing and its overshoot, the gear train, the balance
   * wheel and the detent levers. Frames then depend only on the clock reading,
   * which is what makes screenshots reproducible. Defaults to true, so normal
   * application behaviour is unchanged.
   */
  readonly motion?: boolean;
}

/**
 * Owns the WebGL context, camera, controls and frame loop.
 *
 * Renderer-level concerns only: which scene is showing is decided by the app
 * (via `setScene`), and the UI never talks to this class or to three.js — it
 * goes through the store.
 */
export class ClockRenderer {
  private readonly canvas: HTMLCanvasElement;
  private readonly store: AppStore;
  private readonly timeSource: TimeSource;

  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera: THREE.PerspectiveCamera;
  private readonly controls: OrbitControls;

  private readonly motionEnabled: boolean;

  private view: ClockSceneView | null = null;
  private frameHandle: number | null = null;
  private lastFrameMs = 0;
  private lastStorePushMs = 0;
  private fps = 0;
  private disposed = false;

  /** Last digits handed to the scene; read by the `?testApi` observation surface. */
  private frameCount = 0;

  private readonly resizeObserver: ResizeObserver;
  private readonly onVisibilityChange = (): void => {
    const hidden = document.hidden;
    this.store.set({ hidden });
    if (hidden) this.pause();
    else this.resume();
  };

  constructor({ canvas, store, timeSource, motion = true }: ClockRendererOptions) {
    this.canvas = canvas;
    this.store = store;
    this.timeSource = timeSource;
    this.motionEnabled = motion;

    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      powerPreference: 'high-performance',
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, MAX_PIXEL_RATIO));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;

    if (!this.renderer.capabilities.isWebGL2) {
      // WebGPU is explicitly deferred; WebGL1 is not a supported target either.
      console.warn('[renderer] WebGL2 unavailable — rendering may be degraded.');
    }

    this.camera = new THREE.PerspectiveCamera(45, 1, 0.1, 100);

    this.controls = new OrbitControls(this.camera, canvas);
    // Damping is inertia: the camera keeps gliding for a few frames after an
    // orbit ends. Deterministic captures need the camera to be a pure function
    // of the input it has received, so it is off with `?nomotion`.
    this.controls.enableDamping = this.motionEnabled;
    this.controls.dampingFactor = 0.08;
    this.controls.enablePan = false;

    this.resizeObserver = new ResizeObserver(() => {
      this.resize();
    });
    this.resizeObserver.observe(canvas);
    document.addEventListener('visibilitychange', this.onVisibilityChange);

    this.resize();
  }

  /**
   * Swaps the active scene, fully disposing the previous one first.
   *
   * Later beads switch scenes repeatedly; disposing here (rather than leaving
   * it to the caller) is what keeps that from leaking geometries and materials.
   */
  setScene(definition: SceneDefinition): void {
    this.view?.dispose();
    this.view = new ClockSceneView(this.scene, definition, { motion: this.motionEnabled });
    this.applyCameraConfig(definition);
    this.renderer.toneMappingExposure = definition.lighting.exposure ?? 1;
    // Put the new mechanism on the clock immediately, so a scene switched to
    // while the tab is hidden is already reading the right time when it shows.
    this.syncMechanism(this.timeSource.now());
  }

  /** The active scene view, or null before the first `setScene`. */
  get sceneView(): ClockSceneView | null {
    return this.view;
  }

  /**
   * The digits currently shown on the rings. See `app/testHooks.ts`.
   *
   * Read straight off the mechanism rather than from a copy kept here, so what
   * this reports and what is drawn cannot drift apart.
   */
  getDigits(): readonly number[] {
    return this.view?.displayedDigits ?? [];
  }

  /** Renderer diagnostics for the `?testApi` observation surface. */
  getRenderState(): {
    webgl2: boolean;
    frames: number;
    fps: number;
    running: boolean;
    drawCalls: number;
    triangles: number;
    width: number;
    height: number;
    pixelRatio: number;
    motion: boolean;
    sceneId: string | null;
  } {
    const size = this.renderer.getSize(new THREE.Vector2());
    return {
      webgl2: this.renderer.capabilities.isWebGL2,
      frames: this.frameCount,
      fps: Math.round(this.fps),
      running: this.frameHandle !== null,
      drawCalls: this.renderer.info.render.calls,
      triangles: this.renderer.info.render.triangles,
      width: size.x,
      height: size.y,
      pixelRatio: this.renderer.getPixelRatio(),
      motion: this.motionEnabled,
      sceneId: this.view?.definition.id ?? null,
    };
  }

  start(): void {
    this.store.set({ hidden: document.hidden });
    if (!document.hidden) this.resume();
  }

  dispose(): void {
    this.disposed = true;
    this.pause();
    document.removeEventListener('visibilitychange', this.onVisibilityChange);
    this.resizeObserver.disconnect();
    this.controls.dispose();
    this.view?.dispose();
    this.view = null;
    this.renderer.dispose();
    this.renderer.forceContextLoss();
  }

  private applyCameraConfig(definition: SceneDefinition): void {
    const config = definition.camera;

    this.camera.fov = config.fov;
    this.camera.near = config.near;
    this.camera.far = config.far;
    this.camera.position.set(...config.position);
    this.camera.updateProjectionMatrix();

    this.controls.target.set(...config.target);
    this.controls.minDistance = config.minDistance;
    this.controls.maxDistance = config.maxDistance;
    this.controls.minPolarAngle = config.minPolarAngle;
    this.controls.maxPolarAngle = config.maxPolarAngle;
    this.controls.update();
  }

  private resize(): void {
    const width = this.canvas.clientWidth || window.innerWidth;
    const height = this.canvas.clientHeight || window.innerHeight;

    // A ResizeObserver can fire with a zero-sized box while the canvas is
    // laid out or hidden; a zero height would poison the projection matrix
    // with Infinity and the scene would never come back.
    if (width <= 0 || height <= 0) return;

    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, MAX_PIXEL_RATIO));
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
  }

  private resume(): void {
    if (this.disposed || this.frameHandle !== null) return;
    this.lastFrameMs = performance.now();
    this.frameHandle = requestAnimationFrame(this.frame);
  }

  private pause(): void {
    if (this.frameHandle === null) return;
    cancelAnimationFrame(this.frameHandle);
    this.frameHandle = null;
  }

  private readonly frame = (frameMs: number): void => {
    this.frameHandle = requestAnimationFrame(this.frame);
    this.frameCount += 1;

    const dt = Math.min((frameMs - this.lastFrameMs) / 1000, MAX_FRAME_DELTA_SECONDS);
    this.lastFrameMs = frameMs;
    if (dt > 0) this.fps += (1 / dt - this.fps) * FPS_SMOOTHING;

    if (this.view) {
      const nowMs = this.timeSource.now();
      const remaining = this.syncMechanism(nowMs);

      // The store drives DOM updates, so push at a human-readable rate rather
      // than once per frame.
      if (frameMs - this.lastStorePushMs >= STORE_UPDATE_INTERVAL_MS) {
        this.lastStorePushMs = frameMs;
        this.store.set({
          countdown: computeCountdown(this.store.get().target.atMs, nowMs),
          remaining,
          fps: Math.round(this.fps),
        });
      }
    }

    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  };

  /**
   * Reads the clock and drives the mechanism from it.
   *
   * The countdown the rings show comes from `computeRemaining`, so the
   * `HHH:MM:SS` cap reaches the display: a target more than 999 hours out reads
   * `999:59:59` and holds there until it falls under the cap. Nothing here
   * integrates a frame delta — the mechanism is handed the instant and works
   * out the rest, which is what keeps it right across tab sleeps and clock
   * re-syncs.
   */
  private syncMechanism(nowMs: number): RemainingTime {
    const view = this.view;
    const remaining = computeRemaining(this.store.get().target.atMs, nowMs);
    if (!view) return remaining;

    view.setFrame(
      view.definition.mode === 'clock'
        ? clockFrame(nowMs, view.ringCount)
        : countdownFrame(remaining, view.ringCount),
      nowMs,
    );
    view.update(nowMs);
    return remaining;
  }
}
