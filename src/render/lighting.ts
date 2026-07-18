import * as THREE from 'three';
import type { LightingConfig } from '../scene/types.js';

/**
 * Builds a scene's lights from its `LightingConfig`.
 *
 * The IBL bead extends this: `LightingConfig.environment` already carries a
 * preset id, and the loader it adds should set `scene.environment` (plus
 * `scene.background` when `showAsBackground` is set) here, keeping every other
 * module unchanged.
 */
export class SceneLighting {
  private readonly lights: THREE.Light[] = [];
  private readonly background: THREE.Color;

  constructor(
    private readonly scene: THREE.Scene,
    config: LightingConfig,
  ) {
    this.background = new THREE.Color(config.background);
    scene.background = this.background;

    const ambient = new THREE.AmbientLight(config.ambient.color, config.ambient.intensity);
    this.add(ambient);

    for (const spec of config.directional) {
      const light = new THREE.DirectionalLight(spec.color, spec.intensity);
      light.position.set(...spec.position);
      this.add(light);
    }

    if (config.environment && config.environment.preset !== 'none') {
      console.warn(
        `[lighting] environment preset "${config.environment.preset}" is declared but ` +
          'IBL loading is not implemented yet; falling back to analytic lights.',
      );
    }
  }

  private add(light: THREE.Light): void {
    this.lights.push(light);
    this.scene.add(light);
  }

  dispose(): void {
    for (const light of this.lights) {
      this.scene.remove(light);
      light.dispose();
    }
    this.lights.length = 0;
    if (this.scene.background === this.background) this.scene.background = null;
  }
}
