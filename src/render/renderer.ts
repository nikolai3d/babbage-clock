import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { ClockSceneView } from './clockScene.js';
import { clockDigits, computeCountdown, countdownDigits } from '../time/countdown.js';
import type { AppStore } from '../app/store.js';
import type { SceneDefinition } from '../scene/types.js';
import type { TimeSource } from '../time/target.js';

/** Retina displays gain little above 2x and cost a lot of fill rate. */
const MAX_PIXEL_RATIO = 2;
/** Clamp for the frame delta so a paused tab does not spin gears wildly on resume. */
const MAX_FRAME_DELTA_SECONDS = 0.1;
const FPS_SMOOTHING = 0.1;
const STORE_UPDATE_INTERVAL_MS = 250;

export interface ClockRendererOptions {
  readonly canvas: HTMLCanvasElement;
  readonly store: AppStore;
  readonly timeSource: TimeSource;
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

  private view: ClockSceneView | null = null;
  private frameHandle: number | null = null;
  private lastFrameMs = 0;
  private lastStorePushMs = 0;
  private fps = 0;
  private disposed = false;

  private readonly resizeObserver: ResizeObserver;
  private readonly onVisibilityChange = (): void => {
    const hidden = document.hidden;
    this.store.set({ hidden });
    if (hidden) this.pause();
    else this.resume();
  };

  constructor({ canvas, store, timeSource }: ClockRendererOptions) {
    this.canvas = canvas;
    this.store = store;
    this.timeSource = timeSource;

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
    this.controls.enableDamping = true;
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
    this.view = new ClockSceneView(this.scene, definition);
    this.applyCameraConfig(definition);
    this.renderer.toneMappingExposure = definition.lighting.exposure ?? 1;
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

    const dt = Math.min((frameMs - this.lastFrameMs) / 1000, MAX_FRAME_DELTA_SECONDS);
    this.lastFrameMs = frameMs;
    if (dt > 0) this.fps += (1 / dt - this.fps) * FPS_SMOOTHING;

    const view = this.view;
    if (view) {
      const nowMs = this.timeSource.now();
      const { target } = this.store.get();
      const countdown = computeCountdown(target.atMs, nowMs);
      const definition = view.definition;

      view.setDigits(
        definition.mode === 'clock'
          ? clockDigits(new Date(nowMs), view.ringCount)
          : countdownDigits(countdown, view.ringCount),
      );
      view.update(dt);

      // The store drives DOM updates, so push at a human-readable rate rather
      // than once per frame.
      if (frameMs - this.lastStorePushMs >= STORE_UPDATE_INTERVAL_MS) {
        this.lastStorePushMs = frameMs;
        this.store.set({ countdown, fps: Math.round(this.fps) });
      }
    }

    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  };
}
