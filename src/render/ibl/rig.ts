/**
 * The analytic half of a lighting mood.
 *
 * Image-based lighting alone gives beautiful ambient and reflections and almost
 * no shadow definition: a prefiltered panorama is a very soft area light coming
 * from everywhere at once. Each mood therefore ships a small rig that
 * *complements* the map — a real sun for `sunny-day`, a warm gaslight for the
 * workshop, a cool rim for `night` — so the mechanism keeps its form.
 *
 * Also here: the fallback backdrop, which is what makes background treatment
 * configurable independently of lighting. A scene can be lit by a panorama it
 * never shows, and go on rendering the dark vignette it was designed around.
 */

import * as THREE from 'three';
import type {
  IblBackgroundFallback,
  IblLightSpec,
  IblManifest,
  IblShadowSpec,
} from './manifest.js';

/** Height of the generated backdrop gradient. Cheap, and smooth enough. */
const GRADIENT_HEIGHT = 128;
/** Longitude is constant in a vertical gradient, so a few columns will do. */
const GRADIENT_WIDTH = 4;

/** What a caller that never states a tier gets: the high tier's resolution. */
export const DEFAULT_SHADOW_MAP_SIZE = 2048;

export interface RigOptions {
  /**
   * Side length of the shadow map a casting light renders into. The manifest
   * authors *whether* and *where* its key casts (see `IblShadowSpec`); how many
   * texels that costs is the device's business, so it arrives from the active
   * quality tier rather than from content. See `app/quality.ts`.
   */
  readonly shadowMapSize?: number;
}

/**
 * Builds the mood's lights. The caller owns them: add them to a scene, and
 * `disposeRig` them when the mood changes.
 */
export function createRigLights(manifest: IblManifest, options: RigOptions = {}): THREE.Light[] {
  const shadowMapSize = options.shadowMapSize ?? DEFAULT_SHADOW_MAP_SIZE;
  return manifest.lights.map((spec) => {
    const light = createLight(spec, shadowMapSize);
    light.name = `ibl:${manifest.id}:${spec.name}`;
    return light;
  });
}

function createLight(spec: IblLightSpec, shadowMapSize: number): THREE.Light {
  switch (spec.type) {
    case 'ambient':
      return new THREE.AmbientLight(spec.color, spec.intensity);

    case 'hemisphere':
      return new THREE.HemisphereLight(spec.color, spec.groundColor, spec.intensity);

    case 'directional': {
      const light = new THREE.DirectionalLight(spec.color, spec.intensity);
      light.position.set(...spec.position);
      if (spec.shadow) applyDirectionalShadow(light, spec.shadow, shadowMapSize);
      return light;
    }

    case 'point': {
      const light = new THREE.PointLight(spec.color, spec.intensity, spec.distance, spec.decay);
      light.position.set(...spec.position);
      return light;
    }

    case 'spot': {
      const light = new THREE.SpotLight(
        spec.color,
        spec.intensity,
        spec.distance,
        spec.angle,
        spec.penumbra,
        spec.decay,
      );
      light.position.set(...spec.position);
      // A SpotLight aims at its target's *world* position, and the target is
      // only in the scene graph if someone puts it there. Parenting it to the
      // light and storing the offset keeps the aim right without adding a
      // second object for the controller to track and remove.
      light.add(light.target);
      light.target.position.set(
        spec.target[0] - spec.position[0],
        spec.target[1] - spec.position[1],
        spec.target[2] - spec.position[2],
      );
      return light;
    }
  }
}

/**
 * Turns a manifest's shadow block into a configured shadow camera.
 *
 * The frustum is square — the mechanism is roughly as tall as it is wide from
 * any key-light angle — and authored in the manifest, because content knows
 * what it must cover. Only the resolution comes from the caller: that is the
 * quality tier's lever, not the mood's.
 */
function applyDirectionalShadow(
  light: THREE.DirectionalLight,
  spec: IblShadowSpec,
  mapSize: number,
): void {
  light.castShadow = true;
  light.shadow.mapSize.set(mapSize, mapSize);
  light.shadow.bias = spec.bias;
  light.shadow.normalBias = spec.normalBias;

  const camera = light.shadow.camera;
  camera.left = -spec.radius;
  camera.right = spec.radius;
  camera.top = spec.radius;
  camera.bottom = -spec.radius;
  camera.near = spec.near;
  camera.far = spec.far;
  // The shadow pass reads the projection matrix as-is; nothing recomputes it
  // from the bounds set above, so it has to be stated here.
  camera.updateProjectionMatrix();
}

/** Detaches and releases a rig. Safe to call with an empty list. */
export function disposeRig(scene: THREE.Scene, lights: readonly THREE.Light[]): void {
  for (const light of lights) {
    scene.remove(light);
    // `dispose` on a shadow-casting light also releases its shadow map, so a
    // rig swap cannot strand a render target on the GPU.
    light.dispose();
  }
}

/**
 * The backdrop for a mood whose environment map is not shown.
 *
 * A flat colour is returned as a `Color` (no GPU resource at all); a gradient
 * becomes a small equirectangular texture, which the caller must dispose when
 * it swaps moods.
 */
export function createFallbackBackground(
  fallback: IblBackgroundFallback,
): THREE.Color | THREE.DataTexture {
  if (fallback.kind === 'color') return new THREE.Color(fallback.color);

  const data = new Uint8Array(GRADIENT_WIDTH * GRADIENT_HEIGHT * 4);
  const bottom = new THREE.Color(fallback.bottom);
  const top = new THREE.Color(fallback.top);
  const blended = new THREE.Color();

  for (let row = 0; row < GRADIENT_HEIGHT; row += 1) {
    // Row 0 is v = 0, which an equirectangular background samples at the
    // bottom of the sphere; `power` biases where the light band sits.
    const t = Math.pow(row / (GRADIENT_HEIGHT - 1), fallback.power);
    // Interpolating in the working (linear) space rather than in sRGB is what
    // keeps a dark-to-warm ramp from going muddy through the middle.
    blended.copy(bottom).lerp(top, t);
    const [r, g, b] = toBytes(blended);

    for (let column = 0; column < GRADIENT_WIDTH; column += 1) {
      const offset = (row * GRADIENT_WIDTH + column) * 4;
      data[offset] = r;
      data[offset + 1] = g;
      data[offset + 2] = b;
      data[offset + 3] = 255;
    }
  }

  const texture = new THREE.DataTexture(data, GRADIENT_WIDTH, GRADIENT_HEIGHT);
  texture.name = 'ibl:backdrop-gradient';
  texture.mapping = THREE.EquirectangularReflectionMapping;
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.needsUpdate = true;
  return texture;
}

function toBytes(color: THREE.Color): [number, number, number] {
  const hex = color.getHex(THREE.SRGBColorSpace);
  return [(hex >> 16) & 0xff, (hex >> 8) & 0xff, hex & 0xff];
}

/** Manifest tone-mapping name -> the three.js constant. */
export function toneMappingConstant(name: IblManifest['grade']['toneMapping']): THREE.ToneMapping {
  switch (name) {
    case 'none':
      return THREE.NoToneMapping;
    case 'linear':
      return THREE.LinearToneMapping;
    case 'reinhard':
      return THREE.ReinhardToneMapping;
    case 'cineon':
      return THREE.CineonToneMapping;
    case 'agx':
      return THREE.AgXToneMapping;
    case 'neutral':
      return THREE.NeutralToneMapping;
    case 'aces':
      return THREE.ACESFilmicToneMapping;
  }
}
