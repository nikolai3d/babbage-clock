import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { ClockSceneView } from './clockScene.js';
import { createEnvironmentLibrary } from './ibl/library.js';
import { EnvironmentController } from './lighting.js';
import { MaterialRegistry } from './materialRegistry.js';
import { lookToSlotMap, resolveLook } from '../materials/looks.js';
import { qualitySettings } from '../app/quality.js';
import { frameForAspect, ringStackRadius } from '../scene/framing.js';
import { ringStackSpan } from '../geometry/ringLayout.js';
import { computeCountdown, computeRemaining } from '../time/countdown.js';
import { clockFrame, countdownFrame } from '../mechanism/index.js';
import type { IblStatus } from './lighting.js';
import type { QualitySettings } from '../app/quality.js';
import type { BackgroundPreference } from '../app/urlParams.js';
import type { AppStore } from '../app/store.js';
import { MATERIAL_SLOTS } from '../scene/types.js';
import type { ContentExtent } from '../scene/framing.js';
import type { MaterialSlotMap, SceneDefinition } from '../scene/types.js';
import type { RemainingTime } from '../time/countdown.js';
import type { TimeSource } from '../time/target.js';

/** Clamp for the frame delta so a stalled frame does not spike the fps readout. */
const MAX_FRAME_DELTA_SECONDS = 0.1;
const FPS_SMOOTHING = 0.1;
const STORE_UPDATE_INTERVAL_MS = 250;
/** See the frame ceiling in `frame`. */
const FRAME_CAP_TOLERANCE = 0.9;

/** Radians per arrow-key press when orbiting from the keyboard. */
const KEY_ORBIT_STEP = 0.12;
/** Multiplier per zoom-key press; its reciprocal zooms back out. */
const KEY_DOLLY_STEP = 1.12;

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
   *
   * There is one source for this — `app/motion.ts` — combining the viewer's
   * `prefers-reduced-motion` setting with the `?nomotion=1` hook. Do not add a
   * second media-query check anywhere below this line.
   */
  readonly motion?: boolean;
  /**
   * The GPU took the context away. The frame loop is already paused when this
   * fires; the app is expected to put a non-WebGL view on screen, because a
   * canvas frozen on a stale frame shows the wrong time.
   */
  readonly onContextLost?: () => void;
  /** The context came back and the loop has resumed on the correct instant. */
  readonly onContextRestored?: () => void;
  /**
   * How hard this device may be pushed. Defaults to the high tier, so a caller
   * that does not care gets exactly the behaviour that shipped before tiers
   * existed. See `app/quality.ts`.
   */
  readonly quality?: QualitySettings;
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
  /** Owns the IBL environment, the mood light rig and the tone-mapping grade. */
  private readonly environment: EnvironmentController;

  private motionEnabled: boolean;
  private readonly onContextLostCallback: (() => void) | undefined;
  private readonly onContextRestoredCallback: (() => void) | undefined;
  /**
   * Material folders and their textures, cached across scene and look changes.
   *
   * Owned here rather than by the scene view because it must outlive one: the
   * whole point of the cache is that switching away and back does not
   * re-download anything.
   */
  private readonly materials: MaterialRegistry;
  private materialLook: string | null = null;

  private quality: QualitySettings;
  private backgroundPreference: BackgroundPreference | null = null;
  /**
   * What the active scene needs to keep in frame. Measured from the built scene
   * graph rather than declared, so a scene that grows a part reframes itself.
   */
  private extent: ContentExtent = { contentRadius: 1, ringRadius: 1 };
  private framingFit: 'whole' | 'rings' = 'whole';
  /**
   * True once the viewer has orbited or pinched. From then on the automatic
   * framing stops moving the camera and only tracks the orbit limits.
   */
  private userAdjustedCamera = false;
  /** Timestamp of the last drawn frame, for the low tier's frame ceiling. */
  private lastRenderMs = Number.NEGATIVE_INFINITY;

  private view: ClockSceneView | null = null;
  private definition: SceneDefinition | null = null;
  private frameHandle: number | null = null;
  private lastFrameMs = 0;
  private lastStorePushMs = 0;
  private fps = 0;
  private disposed = false;
  private contextLost = false;

  /** Scratch for keyboard orbiting, so a key press allocates nothing. */
  private readonly orbitOffset = new THREE.Vector3();
  private readonly orbitSpherical = new THREE.Spherical();

  /** Last digits handed to the scene; read by the `?testApi` observation surface. */
  private frameCount = 0;

  private readonly resizeObserver: ResizeObserver;
  /** The viewer has taken the camera; automatic framing stops moving it. */
  private readonly onControlsStart = (): void => {
    this.userAdjustedCamera = true;
  };

  private readonly onVisibilityChange = (): void => {
    const hidden = document.hidden;
    this.store.set({ hidden });
    if (hidden) this.pause();
    else this.resume();
  };

  constructor({
    canvas,
    store,
    timeSource,
    motion = true,
    onContextLost,
    onContextRestored,
    quality = qualitySettings('high'),
  }: ClockRendererOptions) {
    this.canvas = canvas;
    this.store = store;
    this.timeSource = timeSource;
    this.motionEnabled = motion;
    this.onContextLostCallback = onContextLost;
    this.onContextRestoredCallback = onContextRestored;
    this.quality = quality;

    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      powerPreference: 'high-performance',
    });
    this.renderer.setPixelRatio(this.pixelRatio());
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;

    if (!this.renderer.capabilities.isWebGL2) {
      // WebGPU is explicitly deferred; WebGL1 is not a supported target either.
      console.warn('[renderer] WebGL2 unavailable — rendering may be degraded.');
    }

    // Handed the renderer so it can detect KTX2 transcoder support and read
    // the anisotropy cap off the real context rather than guessing.
    this.materials = new MaterialRegistry({ renderer: this.renderer });

    this.camera = new THREE.PerspectiveCamera(45, 1, 0.1, 100);
    this.environment = new EnvironmentController({
      renderer: this.renderer,
      scene: this.scene,
      library: createEnvironmentLibrary(this.renderer),
      panoramaBackground: quality.panoramaBackground,
    });

    this.controls = new OrbitControls(this.camera, canvas);
    // Damping is inertia: the camera keeps gliding for a few frames after an
    // orbit ends. Deterministic captures need the camera to be a pure function
    // of the input it has received, so it is off with `?nomotion`.
    this.controls.enableDamping = this.motionEnabled;
    this.controls.dampingFactor = 0.08;
    this.controls.enablePan = false;
    // Touch: one finger orbits, two fingers pinch-zoom. `DOLLY_PAN` with
    // panning disabled is a pure pinch, which is the predictable gesture — a
    // two-finger drag that also rotated would fight the pinch on every zoom.
    //
    // The listeners are bound to the canvas, never to the document, so a
    // gesture that starts on the settings drawer or anywhere else in the 2D
    // shell is left entirely to the browser. Nothing here calls
    // `preventDefault` on a page-level scroll.
    this.controls.touches = { ONE: THREE.TOUCH.ROTATE, TWO: THREE.TOUCH.DOLLY_PAN };

    this.controls.addEventListener('start', this.onControlsStart);

    this.resizeObserver = new ResizeObserver(() => {
      this.resize();
    });
    this.resizeObserver.observe(canvas);
    document.addEventListener('visibilitychange', this.onVisibilityChange);
    // three.js registers its own handlers for these and calls preventDefault on
    // the loss, which is what makes a restore possible at all. Ours run after
    // and deal with the parts three cannot know about: the frame loop, the
    // clock, and the view the app should show meanwhile.
    canvas.addEventListener('webglcontextlost', this.onWebGLContextLost);
    canvas.addEventListener('webglcontextrestored', this.onWebGLContextRestored);
    // The canvas is the keyboard alternative to dragging: `index.html` gives it
    // `tabindex="0"` and a label, and these keys orbit it. Without this the
    // view would be reachable only with a pointer.
    canvas.addEventListener('keydown', this.onCanvasKeyDown);

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
    this.definition = definition;
    this.view = new ClockSceneView(this.scene, definition, {
      motion: this.motionEnabled,
      materials: this.materials,
      textureSize: this.quality.textureSize,
    });
    if (this.materialLook !== null) this.applyLook(definition);
    this.extent = this.measureExtent(definition);
    this.applyCameraConfig(definition);
    // The lighting mood owns the environment, the rig and the grade — including
    // exposure — and re-asserts itself over the scene that was just rebuilt.
    // A mood that is not resident yet is committed later, all at once.
    this.environment.apply(definition, this.view.lighting);
    // Put the new mechanism on the clock immediately, so a scene switched to
    // while the tab is hidden is already reading the right time when it shows.
    this.syncMechanism(this.timeSource.now());
  }

  /**
   * Swaps every slot to a named look, or back to the scene's own materials.
   *
   * The scene graph is untouched — this is a material rebind, not a rebuild —
   * so it costs no geometry upload and cannot drop a frame's worth of state.
   */
  setMaterialLook(lookId: string | null): void {
    this.materialLook = resolveLook(lookId) ? lookId : null;
    if (this.view) this.applyLook(this.view.definition);
  }

  /** Resolves once the active scene's materials have finished loading. */
  async materialsReady(): Promise<void> {
    await this.view?.materialsReady();
  }

  private applyLook(definition: SceneDefinition): void {
    const look = resolveLook(this.materialLook);
    const bindings: MaterialSlotMap = look ? lookToSlotMap(look) : definition.materials;
    this.view?.setMaterials(bindings);
  }

  /** The active scene view, or null before the first `setScene`. */
  get sceneView(): ClockSceneView | null {
    return this.view;
  }

  /**
   * Turns continuous animation on or off after construction.
   *
   * The viewer can flip `prefers-reduced-motion` while the page is open, and
   * `Mechanism` takes its motion setting at construction, so honouring the
   * change means rebuilding the view. That is a scene swap, which this class
   * already does correctly (and disposes properly) for the scene picker — so
   * there is no second path, and no per-frame branch to keep in sync.
   *
   * The camera is untouched: the viewer's orbit survives.
   */
  setMotion(enabled: boolean): void {
    if (enabled === this.motionEnabled) return;
    this.motionEnabled = enabled;
    this.controls.enableDamping = enabled;

    const definition = this.definition;
    if (!definition) return;
    this.view?.dispose();
    this.view = new ClockSceneView(this.scene, definition, {
      motion: enabled,
      textureSize: this.quality.textureSize,
    });
    this.syncMechanism(this.timeSource.now());
  }

  /**
   * Changes the quality tier at runtime, from the settings drawer.
   *
   * Everything a tier controls is re-derivable, so this is a live switch rather
   * than a reload: pixel ratio and the frame cap apply on the next frame, and
   * the environment controller re-commits its background atomically. The
   * texture-size preference reaches the material pipeline on the next
   * `setScene`, which is when materials are rebuilt anyway.
   */
  setQuality(quality: QualitySettings): void {
    this.quality = quality;
    this.applyQuality();
  }

  /**
   * The viewer's backdrop choice, layered over the tier's default.
   *
   * Goes through `applyQuality` so it lands with the same atomic re-commit the
   * tier change uses — the environment controller swaps backdrop, blurriness
   * and intensity in one synchronous pass either way.
   */
  setBackgroundPreference(preference: BackgroundPreference | null): void {
    this.backgroundPreference = preference;
    this.applyQuality();
  }

  /** The tier currently in force. */
  get qualityTier(): QualitySettings['tier'] {
    return this.quality.tier;
  }

  /**
   * Re-asserts everything a lost-and-restored WebGL context forgets.
   *
   * A restored context comes back at the browser's default pixel ratio and
   * drawing-buffer size, so the tier's cap and the derived framing have to be
   * stated again — otherwise a phone silently starts shading at 3x after the
   * first context loss, which is exactly the state the tier exists to avoid.
   *
   * The camera is deliberately left alone, the same way `setMotion` leaves it:
   * a context loss is not a reason to throw away the viewer's orbit. `resize`
   * re-derives the framing, which respects that too.
   */
  refresh(): void {
    if (this.disposed) return;
    this.applyQuality();
    this.resize();
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
    /** Live GPU textures, straight off `renderer.info.memory`. Leak canary. */
    textures: number;
    /** Live GPU geometries, likewise. */
    geometries: number;
    width: number;
    height: number;
    pixelRatio: number;
    motion: boolean;
    contextLost: boolean;
    cameraPosition: readonly [number, number, number];
    sceneId: string | null;
    lighting: IblStatus;
    quality: QualitySettings['tier'];
    maxFps: number | null;
    framingFit: 'whole' | 'rings';
    ringExtentPx: number;
    /** Whether the mood's HDR panorama is the backdrop, after every override. */
    panoramaBackground: boolean;
  } {
    const size = this.renderer.getSize(new THREE.Vector2());
    return {
      webgl2: this.renderer.capabilities.isWebGL2,
      frames: this.frameCount,
      fps: Math.round(this.fps),
      running: this.frameHandle !== null,
      drawCalls: this.renderer.info.render.calls,
      triangles: this.renderer.info.render.triangles,
      textures: this.renderer.info.memory.textures,
      geometries: this.renderer.info.memory.geometries,
      width: size.x,
      height: size.y,
      pixelRatio: this.renderer.getPixelRatio(),
      motion: this.motionEnabled,
      contextLost: this.contextLost,
      cameraPosition: [this.camera.position.x, this.camera.position.y, this.camera.position.z],
      sceneId: this.view?.definition.id ?? null,
      // A frame captured while this is 'loading' still shows the previous
      // mood, so anything photographing the scene has to wait it out.
      lighting: this.environment.status,
      quality: this.quality.tier,
      maxFps: this.quality.maxFps,
      framingFit: this.framingFit,
      ringExtentPx: this.measureRingExtentPx(),
      panoramaBackground:
        this.backgroundPreference === 'panorama'
          ? true
          : this.backgroundPreference === 'backdrop'
            ? false
            : this.quality.panoramaBackground,
    };
  }

  /**
   * What the materials layer is currently doing. See `app/testHooks.ts`.
   *
   * Reported rather than inferred because the two things worth asserting about
   * a hot swap — that it took effect, and that it released what it replaced —
   * are invisible in a screenshot.
   */
  getMaterialState(): {
    look: string | null;
    slots: Record<string, string>;
    textures: number;
    sources: number;
    pending: number;
    ktx2: boolean;
  } {
    const stats = this.materials.stats();
    const slots: Record<string, string> = {};
    if (this.view) {
      for (const slot of MATERIAL_SLOTS) {
        const binding = this.view.bindingFor(slot);
        slots[slot] = binding.kind === 'pbr' ? `pbr:${binding.textureSet}` : 'placeholder';
      }
    }
    return {
      look: this.materialLook,
      slots,
      textures: stats.textures,
      sources: stats.sources,
      pending: stats.pending,
      ktx2: stats.ktx2,
    };
  }

  /**
   * How wide the ring stack is on screen, in CSS pixels.
   *
   * This is the number the mobile acceptance criterion is actually about — "the
   * reading is legible without interaction" is "the drums are big and all of
   * them are on screen" — so it is measured rather than eyeballed. Projecting
   * the two ends of the stack through the live camera is the same arithmetic
   * the GPU does, which is why it can be trusted as a proxy for the picture.
   */
  private measureRingExtentPx(): number {
    const definition = this.view?.definition;
    if (!definition) return 0;

    const size = this.renderer.getSize(new THREE.Vector2());
    const axis = definition.rings.axis;
    // The stack itself, not the sphere the framing fits: this number is read as
    // "how much of the screen do the drums occupy", so it has to be the drums.
    const half = ringStackSpan(definition.rings) / 2;
    const target = definition.camera.target;
    const offset = new THREE.Vector3(
      axis === 'x' ? half : 0,
      axis === 'y' ? half : 0,
      axis === 'z' ? half : 0,
    );

    const a = new THREE.Vector3(...target).sub(offset).project(this.camera);
    const b = new THREE.Vector3(...target).add(offset).project(this.camera);
    return (Math.abs(b.x - a.x) / 2) * size.x;
  }

  start(): void {
    this.store.set({ hidden: document.hidden });
    if (!document.hidden) this.resume();
  }

  dispose(): void {
    this.disposed = true;
    this.pause();
    document.removeEventListener('visibilitychange', this.onVisibilityChange);
    this.canvas.removeEventListener('webglcontextlost', this.onWebGLContextLost);
    this.canvas.removeEventListener('webglcontextrestored', this.onWebGLContextRestored);
    this.canvas.removeEventListener('keydown', this.onCanvasKeyDown);
    this.resizeObserver.disconnect();
    this.controls.removeEventListener('start', this.onControlsStart);
    this.controls.dispose();
    // Before the view: the controller detaches its rig from the same scene.
    this.environment.dispose();
    this.view?.dispose();
    this.view = null;
    this.materials.dispose();
    this.renderer.dispose();
    this.renderer.forceContextLoss();
  }

  /**
   * The bounding radii the framing works from, measured off the scene graph.
   *
   * Both are radii about the camera *target*, because that is the point the
   * camera orbits: a radius about the geometric centre would be wrong by the
   * offset between them. `contentRadius` covers everything drawn — case, lid,
   * shackle, gear train — and `ringRadius` comes from `RingConfig` maths, so it
   * is exactly the drums and nothing else.
   */
  private measureExtent(definition: SceneDefinition): ContentExtent {
    const target = new THREE.Vector3(...definition.camera.target);
    const box = new THREE.Box3().setFromObject(this.scene);

    let contentRadius = 0;
    if (!box.isEmpty()) {
      const corner = new THREE.Vector3();
      for (const x of [box.min.x, box.max.x]) {
        for (const y of [box.min.y, box.max.y]) {
          for (const z of [box.min.z, box.max.z]) {
            contentRadius = Math.max(contentRadius, corner.set(x, y, z).distanceTo(target));
          }
        }
      }
    }

    const ringRadius = ringStackRadius(definition.rings);
    // A scene whose bounding box somehow came back empty still has rings.
    return { contentRadius: Math.max(contentRadius, ringRadius), ringRadius };
  }

  /** The framing for the viewport as it is right now. */
  private currentFraming(definition: SceneDefinition): ReturnType<typeof frameForAspect> {
    return frameForAspect({
      camera: definition.camera,
      aspect: this.camera.aspect,
      extent: this.extent,
    });
  }

  /**
   * Places the camera for a scene. Resets the viewer's orbit, which is correct
   * here: a new scene is a new subject.
   */
  private applyCameraConfig(definition: SceneDefinition): void {
    const config = definition.camera;
    const framing = this.currentFraming(definition);

    this.camera.fov = config.fov;
    this.camera.near = config.near;
    this.camera.far = config.far;
    this.camera.position.set(...framing.position);
    this.camera.updateProjectionMatrix();

    this.controls.target.set(...config.target);
    this.controls.minPolarAngle = config.minPolarAngle;
    this.controls.maxPolarAngle = config.maxPolarAngle;
    this.applyFramingLimits(framing);
    this.userAdjustedCamera = false;
    this.controls.update();
  }

  /**
   * Re-frames for a new aspect ratio — a rotated phone, a resized window, a
   * keyboard opening under a bottom sheet.
   *
   * The distance is only re-applied while the viewer has not moved the camera
   * themselves. Snatching a pose back from someone mid-orbit because the
   * address bar collapsed would be worse than a slightly loose frame; the
   * limits still track the aspect either way, so the pose that fits is always
   * reachable.
   */
  private applyFraming(): void {
    const definition = this.view?.definition;
    if (!definition) return;

    const framing = this.currentFraming(definition);
    this.applyFramingLimits(framing);
    if (!this.userAdjustedCamera) {
      this.camera.position.set(...framing.position);
    }
    this.controls.update();
  }

  private applyFramingLimits(framing: ReturnType<typeof frameForAspect>): void {
    this.controls.minDistance = framing.minDistance;
    this.controls.maxDistance = framing.maxDistance;
    this.framingFit = framing.fit;
  }

  /** Pixel ratio for this device under the active tier. */
  private pixelRatio(): number {
    return Math.min(window.devicePixelRatio || 1, this.quality.maxPixelRatio);
  }

  /** Applies everything the current tier controls to the live renderer. */
  private applyQuality(): void {
    this.renderer.setPixelRatio(this.pixelRatio());
    // The viewer's explicit choice wins in either direction; 'auto' (and null)
    // defers to the tier. Forcing the panorama on a low-tier device spends the
    // cost the tier tried to save — the tier is a default, not a policy.
    const preference = this.backgroundPreference;
    const panorama =
      preference === 'panorama'
        ? true
        : preference === 'backdrop'
          ? false
          : this.quality.panoramaBackground;
    this.environment.setPanoramaBackground(panorama);
  }

  private resize(): void {
    const width = this.canvas.clientWidth || window.innerWidth;
    const height = this.canvas.clientHeight || window.innerHeight;

    // A ResizeObserver can fire with a zero-sized box while the canvas is
    // laid out or hidden; a zero height would poison the projection matrix
    // with Infinity and the scene would never come back.
    if (width <= 0 || height <= 0) return;

    this.renderer.setPixelRatio(this.pixelRatio());
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    // After the projection matrix, because the framing reads `camera.aspect`.
    this.applyFraming();
  }

  /**
   * The context is gone. three.js has already called `preventDefault` (which is
   * what allows a restore at all) and stopped touching GL; this stops the loop
   * so nothing spins on a dead context, and tells the app to show text instead.
   */
  private readonly onWebGLContextLost = (): void => {
    if (this.disposed || this.contextLost) return;
    this.contextLost = true;
    this.pause();
    console.warn('[renderer] WebGL context lost — falling back to the text countdown.');
    this.onContextLostCallback?.();
  };

  /**
   * The context is back. three.js re-initialises its own GL state and re-uploads
   * geometry and materials on the next render, so the scene graph, the active
   * scene and the viewer's camera all survive untouched. What has to be redone
   * here is the part that is a function of *time*: the mechanism is seeked to
   * the current instant before the first frame, so the rings come back reading
   * the right digits rather than the ones frozen at the moment of the loss.
   */
  private readonly onWebGLContextRestored = (): void => {
    if (this.disposed || !this.contextLost) return;
    this.contextLost = false;
    this.resize();
    this.syncMechanism(this.timeSource.now());
    if (!document.hidden) this.resume();
    this.onContextRestoredCallback?.();
  };

  /**
   * Keyboard orbiting: the alternative to dragging the canvas.
   *
   * Arrow keys orbit, `+`/`-` (and PageUp/PageDown) dolly, `Home` or `R` puts
   * the camera back where the scene asked for it — an escape hatch, since a
   * keyboard user cannot "throw" the view back into place. Every step is
   * discrete and applied immediately, so this is unaffected by reduced motion:
   * there is no easing to disable.
   */
  private readonly onCanvasKeyDown = (event: KeyboardEvent): void => {
    if (event.altKey || event.ctrlKey || event.metaKey) return;

    switch (event.key) {
      case 'ArrowLeft':
        this.orbitBy(-KEY_ORBIT_STEP, 0);
        break;
      case 'ArrowRight':
        this.orbitBy(KEY_ORBIT_STEP, 0);
        break;
      case 'ArrowUp':
        this.orbitBy(0, -KEY_ORBIT_STEP);
        break;
      case 'ArrowDown':
        this.orbitBy(0, KEY_ORBIT_STEP);
        break;
      case '+':
      case '=':
      case 'PageUp':
        this.dollyBy(1 / KEY_DOLLY_STEP);
        break;
      case '-':
      case '_':
      case 'PageDown':
        this.dollyBy(KEY_DOLLY_STEP);
        break;
      case 'Home':
      case 'r':
      case 'R':
        if (this.definition) this.applyCameraConfig(this.definition);
        break;
      default:
        return;
    }

    // Only reached for a key we acted on, so page scrolling and browser
    // shortcuts are left alone otherwise.
    event.preventDefault();
  };

  /** Moves the camera on its sphere about the orbit target. */
  private orbitBy(deltaTheta: number, deltaPhi: number): void {
    this.orbitOffset.copy(this.camera.position).sub(this.controls.target);
    this.orbitSpherical.setFromVector3(this.orbitOffset);
    this.orbitSpherical.theta += deltaTheta;
    // The same limits the pointer path obeys, so neither route can put the
    // camera somewhere the scene says it may not go.
    this.orbitSpherical.phi = clamp(
      this.orbitSpherical.phi + deltaPhi,
      this.controls.minPolarAngle,
      this.controls.maxPolarAngle,
    );
    this.applyOrbit();
  }

  private dollyBy(factor: number): void {
    this.orbitOffset.copy(this.camera.position).sub(this.controls.target);
    this.orbitSpherical.setFromVector3(this.orbitOffset);
    this.orbitSpherical.radius = clamp(
      this.orbitSpherical.radius * factor,
      this.controls.minDistance,
      this.controls.maxDistance,
    );
    this.applyOrbit();
  }

  private applyOrbit(): void {
    // The keyboard path does not go through OrbitControls, so it would not fire
    // the `start` event the pointer path uses to claim the camera. Without this
    // the next resize — a rotated phone, an opening keyboard — would snap a
    // keyboard user's view back to the automatic pose.
    this.userAdjustedCamera = true;
    this.orbitOffset.setFromSpherical(this.orbitSpherical);
    this.camera.position.copy(this.controls.target).add(this.orbitOffset);
    this.camera.lookAt(this.controls.target);
    this.controls.update();
  }

  private resume(): void {
    if (this.disposed || this.contextLost || this.frameHandle !== null) return;
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

    // The low tier's frame ceiling. Skipping the whole body — not just the
    // draw — is the point: on a device that could run at 60 this halves the
    // work, and the mechanism does not care, because every transform is a
    // function of the instant rather than of an accumulated delta.
    //
    // The 10% slack matters: at exactly one interval a 30 fps cap on a 60 Hz
    // display lands a hair short of every second vsync and collapses to 20.
    const maxFps = this.quality.maxFps;
    if (maxFps !== null && frameMs - this.lastRenderMs < (1000 / maxFps) * FRAME_CAP_TOLERANCE) {
      return;
    }
    this.lastRenderMs = frameMs;
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

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}
