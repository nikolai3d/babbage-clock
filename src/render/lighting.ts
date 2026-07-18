import * as THREE from 'three';
import {
  createFallbackBackground,
  createRigLights,
  disposeRig,
  toneMappingConstant,
} from './ibl/rig.js';
import type { EnvironmentSource, LoadedEnvironment } from './ibl/library.js';
import type { IblManifest } from './ibl/manifest.js';
import type { EnvironmentSpec, LightingConfig, SceneDefinition } from '../scene/types.js';

/**
 * Builds a scene's lights from its `LightingConfig`.
 *
 * These are the scene's *own* analytic lights, and they are what it looks like
 * with no environment at all. A lighting mood ships a complete rig of its own
 * (see `ibl/rig.ts`), so `EnvironmentController` dims these to the mood's
 * `sceneLightScale` — 0 for every shipped mood — while one is active, and
 * restores them when the mood is `none`.
 */
export class SceneLighting {
  private readonly lights: THREE.Light[] = [];
  private readonly baseIntensities: number[] = [];
  private readonly background: THREE.Color;
  private analyticScale = 1;

  constructor(
    private readonly scene: THREE.Scene,
    config: LightingConfig,
  ) {
    this.background = new THREE.Color(config.background);
    scene.background = this.background;

    this.add(new THREE.AmbientLight(config.ambient.color, config.ambient.intensity));

    for (const spec of config.directional) {
      const light = new THREE.DirectionalLight(spec.color, spec.intensity);
      light.position.set(...spec.position);
      this.add(light);
    }
  }

  private add(light: THREE.Light): void {
    this.lights.push(light);
    this.baseIntensities.push(light.intensity);
    light.intensity *= this.analyticScale;
    this.scene.add(light);
  }

  /**
   * Scales every light this scene declared, so a mood can take the lighting
   * over without the scene's own key doubling up on the mood's.
   *
   * Scaling rather than hiding keeps the lights in the scene graph, which is
   * what lets a mood be reverted in a single frame.
   */
  setAnalyticScale(scale: number): void {
    this.analyticScale = scale;
    for (let i = 0; i < this.lights.length; i += 1) {
      this.lights[i]!.intensity = this.baseIntensities[i]! * scale;
    }
  }

  /** Re-asserts the scene's own backdrop, undoing a mood's background. */
  restoreBackground(): void {
    this.scene.background = this.background;
  }

  dispose(): void {
    for (const light of this.lights) {
      this.scene.remove(light);
      light.dispose();
    }
    this.lights.length = 0;
    this.baseIntensities.length = 0;
    if (this.scene.background === this.background) this.scene.background = null;
  }
}

/** What `data-ibl` on `<html>` reports; e2e waits on `ready` before shooting. */
export type IblStatus = 'none' | 'loading' | 'ready' | 'error';

export interface EnvironmentControllerOptions {
  /** Only the grade is written here, which is all a test needs to stand in for. */
  readonly renderer: Pick<THREE.WebGLRenderer, 'toneMapping' | 'toneMappingExposure'>;
  readonly scene: THREE.Scene;
  readonly library: EnvironmentSource;
  /**
   * Whether the mood may draw its HDR panorama as the background. False on the
   * low quality tier, which falls back to the mood's authored gradient — see
   * `app/quality.ts` for why this is the environment lever worth pulling.
   * Defaults to true, so nothing that does not care changes behaviour.
   */
  readonly panoramaBackground?: boolean;
}

interface CommittedMood {
  readonly id: string;
  readonly manifest: IblManifest;
  readonly texture: THREE.Texture;
}

/**
 * Applies a lighting mood: environment map, background, light rig and grade.
 *
 * The contract that matters is **atomicity**. Loading a panorama is
 * asynchronous, but committing one is not: `commit` sets the environment, the
 * background, the rig, the fog and the tone-mapping grade in a single
 * synchronous block, so no frame is ever drawn with one mood's environment and
 * another's lights. A mood that is already prefiltered commits inside `apply`
 * itself; one that is not leaves the previously committed mood whole on screen —
 * re-stated over the rebuilt scene by `reassert()` — until it is ready.
 *
 * Ownership is split with `SceneLighting`, which owns the scene's declared
 * lights and backdrop colour. This class owns `scene.environment`, `scene.fog`,
 * the background override, the rig and the renderer's grade — and releases all
 * of them when the mood becomes `none` or the renderer goes away.
 */
export class EnvironmentController {
  private readonly renderer: EnvironmentControllerOptions['renderer'];
  private readonly scene: THREE.Scene;
  private readonly library: EnvironmentSource;

  private lighting: SceneLighting | null = null;
  private definition: SceneDefinition | null = null;

  private committed: CommittedMood | null = null;
  private rig: THREE.Light[] = [];
  private backdrop: THREE.DataTexture | null = null;
  /** Which mood `backdrop` was generated for, so an unchanged one is reused. */
  private backdropKey: string | null = null;

  /** Guards against a slow load for a mood the viewer has already left. */
  private requestId = 0;
  private state: IblStatus = 'none';
  private disposed = false;
  private panoramaBackground: boolean;

  constructor({
    renderer,
    scene,
    library,
    panoramaBackground = true,
  }: EnvironmentControllerOptions) {
    this.renderer = renderer;
    this.scene = scene;
    this.library = library;
    this.panoramaBackground = panoramaBackground;
  }

  /**
   * Allows or forbids the panorama background, for a quality-tier change made
   * while a mood is on screen.
   *
   * Goes through `reassert` rather than poking `scene.background`, so the swap
   * keeps the same atomicity guarantee as everything else here: the background,
   * its blurriness, rotation and intensity all change in one synchronous pass
   * or not at all.
   */
  setPanoramaBackground(allowed: boolean): void {
    if (this.disposed || allowed === this.panoramaBackground) return;
    this.panoramaBackground = allowed;
    this.reassert();
  }

  /** Prefiltered environment maps currently resident. Mirrors `renderer.info`. */
  get liveEnvironments(): number {
    return this.library.liveTargets;
  }

  /** The mood on screen right now, or null when none is applied. */
  get activeMood(): string | null {
    return this.committed?.id ?? null;
  }

  /**
   * Whether a mood is on screen, still loading, off, or failed.
   *
   * Surfaced through the test API and on `<html data-ibl>` so a screenshot can
   * wait for the lighting to settle instead of racing an HDR download.
   */
  get status(): IblStatus {
    return this.state;
  }

  /**
   * Points the controller at a freshly built scene and its declared preset.
   *
   * Called on every `setScene`, including a plain scene change: the new
   * `SceneLighting` has just reset the background and added its own lights at
   * full strength, so the committed mood has to be re-asserted over it before
   * the next frame regardless of whether the mood itself changed.
   */
  apply(definition: SceneDefinition, lighting: SceneLighting): void {
    if (this.disposed) return;

    this.definition = definition;
    this.lighting = lighting;

    const spec = definition.lighting.environment;
    const requested = spec?.preset ?? 'none';
    const request = (this.requestId += 1);

    if (requested === 'none') {
      this.commitNone();
      return;
    }

    const cached = this.library.peek(requested);
    if (cached) {
      // Been here before: no network, no PMREM, no intermediate state at all.
      // Committing straight away also skips re-asserting a mood that is about
      // to be replaced in the same call, which would build a backdrop only to
      // throw it away a line later.
      this.commit(requested, cached, spec);
      return;
    }

    // The mood is not resident, so the scene has to look coherent for however
    // many frames the load takes. Re-state whatever is currently committed.
    this.reassert();
    this.setStatus('loading');
    void this.library
      .load(requested)
      .then((loaded) => {
        if (this.disposed || request !== this.requestId) return;
        this.commit(requested, loaded, this.definition?.lighting.environment);
      })
      .catch((error: unknown) => {
        if (this.disposed || request !== this.requestId) return;
        // A mood that will not load must not leave a half-applied one behind:
        // the previously committed mood is still whole, so keep showing it.
        console.warn(`[lighting] mood "${requested}" could not be applied:`, error);
        this.setStatus(this.committed ? 'ready' : 'error');
      });
  }

  /**
   * Re-applies the committed mood over a scene graph that was rebuilt beneath
   * it. Everything here is a re-statement of what `commit` already decided, so
   * it can never introduce a mismatch of its own.
   */
  private reassert(): void {
    const committed = this.committed;
    if (!committed) {
      // Nothing committed yet: the scene's own lights and backdrop are a
      // complete, coherent look, and they are already in place. Leave them —
      // this is why a non-default mood never blocks first paint.
      this.applyGrade(null);
      return;
    }
    this.commit(committed.id, committed, this.definition?.lighting.environment);
  }

  /**
   * The atomic swap. Every property a mood owns is written here, in one
   * synchronous pass, or not at all.
   */
  private commit(
    id: string,
    loaded: LoadedEnvironment | CommittedMood,
    spec: EnvironmentSpec | undefined,
  ): void {
    const { manifest, texture } = loaded;
    const scene = this.scene;

    scene.environment = texture;
    scene.environmentIntensity = manifest.environment.intensity * (spec?.intensity ?? 1);
    scene.environmentRotation.set(0, manifest.environment.rotation, 0);

    // Background treatment is deliberately independent of lighting: a scene
    // may be lit by a panorama it never shows. `showAsBackground` on the scene
    // wins over the mood's own default when it is set.
    const showPanorama =
      this.panoramaBackground &&
      (spec?.showAsBackground ?? manifest.background.mode === 'environment');

    if (showPanorama) {
      this.releaseBackdrop();
      scene.background = texture;
      scene.backgroundBlurriness = manifest.background.blurriness;
      scene.backgroundRotation.set(0, manifest.environment.rotation, 0);
    } else {
      scene.background = this.backdropFor(id, manifest.background.fallback);
      scene.backgroundBlurriness = 0;
      scene.backgroundRotation.set(0, 0, 0);
    }
    scene.backgroundIntensity = manifest.background.intensity;

    scene.fog = manifest.fog
      ? new THREE.Fog(manifest.fog.color, manifest.fog.near, manifest.fog.far)
      : null;

    disposeRig(scene, this.rig);
    this.rig = createRigLights(manifest);
    for (const light of this.rig) scene.add(light);

    this.lighting?.setAnalyticScale(manifest.sceneLightScale);
    this.applyGrade(manifest);

    this.committed = { id, manifest, texture };
    this.setStatus('ready');
  }

  /** Tears the mood down and hands the scene back to its own lighting. */
  private commitNone(): void {
    const scene = this.scene;

    scene.environment = null;
    scene.environmentIntensity = 1;
    scene.environmentRotation.set(0, 0, 0);
    scene.backgroundBlurriness = 0;
    scene.backgroundIntensity = 1;
    scene.backgroundRotation.set(0, 0, 0);
    scene.fog = null;

    disposeRig(scene, this.rig);
    this.rig = [];
    this.releaseBackdrop();

    this.lighting?.setAnalyticScale(1);
    this.lighting?.restoreBackground();
    this.applyGrade(null);

    this.committed = null;
    this.setStatus('none');
  }

  /**
   * Exposure and tone mapping.
   *
   * The mood grades; the scene trims. Multiplying the two means a scene author
   * can pull a preset down half a stop for their look without redefining every
   * mood, and a scene with no exposure of its own gets the mood's unchanged.
   */
  private applyGrade(manifest: IblManifest | null): void {
    const sceneExposure = this.definition?.lighting.exposure ?? 1;
    this.renderer.toneMapping = manifest
      ? toneMappingConstant(manifest.grade.toneMapping)
      : THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = (manifest?.grade.exposure ?? 1) * sceneExposure;
  }

  /**
   * The generated backdrop for a mood, reused while the mood does not change.
   *
   * `commit` runs on every `setScene`, not only on a mood change, so building a
   * fresh gradient every time would churn a texture per scene switch for a
   * picture that is bit-for-bit identical.
   */
  private backdropFor(
    id: string,
    fallback: IblManifest['background']['fallback'],
  ): THREE.Color | THREE.DataTexture {
    if (this.backdrop && this.backdropKey === id) return this.backdrop;

    this.releaseBackdrop();
    const created = createFallbackBackground(fallback);
    if (created instanceof THREE.DataTexture) {
      this.backdrop = created;
      this.backdropKey = id;
    }
    return created;
  }

  private releaseBackdrop(): void {
    this.backdrop?.dispose();
    this.backdrop = null;
    this.backdropKey = null;
  }

  /**
   * Published on `<html data-ibl>` so the e2e suite can wait for a mood to be
   * on screen instead of racing an HDR download. See `docs/lighting.md`.
   */
  private setStatus(status: IblStatus): void {
    this.state = status;
    if (typeof document === 'undefined') return;
    document.documentElement.dataset['ibl'] = status;
  }

  dispose(): void {
    this.disposed = true;
    disposeRig(this.scene, this.rig);
    this.rig = [];
    this.releaseBackdrop();
    this.scene.environment = null;
    this.scene.fog = null;
    // The backdrop and the environment map are both about to be released, so
    // leaving either one referenced as the background would outlive its texture.
    this.scene.background = null;
    this.library.dispose();
    this.lighting = null;
    this.definition = null;
    this.committed = null;
  }
}
