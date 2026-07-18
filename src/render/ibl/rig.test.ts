import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import {
  createFallbackBackground,
  createRigLights,
  disposeRig,
  toneMappingConstant,
} from './rig.js';
import { parseIblManifest } from './manifest.js';
import type { IblManifest } from './manifest.js';

function manifestWith(lights: readonly unknown[]): IblManifest {
  return parseIblManifest(
    {
      id: 'rig',
      name: 'Rig',
      environment: { file: 'a.hdr', format: 'rgbe' },
      background: { mode: 'environment', fallback: { kind: 'color', color: '#000000' } },
      grade: { exposure: 1, toneMapping: 'aces' },
      lights,
      source: {
        title: 'T',
        authors: ['A'],
        provider: 'P',
        url: 'https://example.invalid',
        licence: 'CC0-1.0',
      },
    },
    'rig',
  );
}

describe('createRigLights', () => {
  it('builds the three.js light each spec describes', () => {
    const lights = createRigLights(
      manifestWith([
        { type: 'ambient', name: 'amb', color: '#404040', intensity: 0.2 },
        { type: 'hemisphere', name: 'hemi', color: '#ffffff', groundColor: '#332211' },
        { type: 'directional', name: 'sun', color: '#fff2d8', intensity: 3.4, position: [6, 7, 4] },
        {
          type: 'point',
          name: 'lamp',
          color: '#ffa64d',
          intensity: 26,
          position: [-3, 2, 3],
          distance: 18,
          decay: 2,
        },
      ]),
    );

    expect(lights[0]).toBeInstanceOf(THREE.AmbientLight);
    expect(lights[1]).toBeInstanceOf(THREE.HemisphereLight);

    const sun = lights[2] as THREE.DirectionalLight;
    expect(sun).toBeInstanceOf(THREE.DirectionalLight);
    expect(sun.intensity).toBeCloseTo(3.4);
    expect(sun.position.toArray()).toEqual([6, 7, 4]);

    const lamp = lights[3] as THREE.PointLight;
    expect(lamp.distance).toBe(18);
    expect(lamp.decay).toBe(2);
  });

  it('namespaces every light so a mood can be found in the scene graph', () => {
    const lights = createRigLights(
      manifestWith([{ type: 'directional', name: 'key', color: '#ffffff', position: [1, 1, 1] }]),
    );
    expect(lights[0]!.name).toBe('ibl:rig:key');
  });

  it('parents a spot light to its own target so the aim survives being added', () => {
    const [light] = createRigLights(
      manifestWith([
        {
          type: 'spot',
          name: 'spot',
          color: '#ffffff',
          position: [0, 4, 0],
          target: [0, 0, 2],
          angle: 0.5,
          penumbra: 0.3,
        },
      ]),
    );
    const spot = light as THREE.SpotLight;
    const scene = new THREE.Scene();
    scene.add(spot);
    scene.updateMatrixWorld(true);

    expect(spot.children).toContain(spot.target);
    // The target must end up where the manifest said, in world space.
    expect(spot.target.getWorldPosition(new THREE.Vector3()).toArray()).toEqual([0, 0, 2]);
    expect(spot.penumbra).toBeCloseTo(0.3);
  });

  it('detaches and releases a whole rig', () => {
    const scene = new THREE.Scene();
    const lights = createRigLights(
      manifestWith([
        { type: 'directional', name: 'a', color: '#ffffff', position: [1, 1, 1] },
        { type: 'point', name: 'b', color: '#ffffff', position: [0, 1, 0] },
      ]),
    );
    for (const light of lights) scene.add(light);
    expect(scene.children).toHaveLength(2);

    disposeRig(scene, lights);
    expect(scene.children).toHaveLength(0);
  });
});

describe('createFallbackBackground', () => {
  it('returns a plain colour for a flat backdrop, allocating nothing', () => {
    const background = createFallbackBackground({ kind: 'color', color: 0x151013 });

    expect(background).toBeInstanceOf(THREE.Color);
    expect((background as THREE.Color).getHex()).toBe(0x151013);
  });

  it('renders a gradient as an equirectangular texture running dark to light', () => {
    const background = createFallbackBackground({
      kind: 'gradient',
      top: 0xffffff,
      bottom: 0x000000,
      power: 1,
    });

    expect(background).toBeInstanceOf(THREE.DataTexture);
    const texture = background as THREE.DataTexture;
    expect(texture.mapping).toBe(THREE.EquirectangularReflectionMapping);
    expect(texture.colorSpace).toBe(THREE.SRGBColorSpace);

    const data = texture.image.data as Uint8Array;
    const width = texture.image.width;
    const height = texture.image.height;
    const rowStart = (row: number): number => row * width * 4;

    // Row 0 is v = 0, the bottom of the sphere; the last row is the top.
    expect(data[rowStart(0)]).toBe(0);
    expect(data[rowStart(height - 1)]).toBe(255);
    expect(data[rowStart(Math.floor(height / 2))]).toBeGreaterThan(0);
    // Opaque everywhere: a backdrop with alpha would composite the clear
    // colour through it.
    expect(data[3]).toBe(255);
  });

  it('honours the gradient power, which is what moves the light band', () => {
    const linear = createFallbackBackground({
      kind: 'gradient',
      top: 0xffffff,
      bottom: 0x000000,
      power: 1,
    }) as THREE.DataTexture;
    const biased = createFallbackBackground({
      kind: 'gradient',
      top: 0xffffff,
      bottom: 0x000000,
      power: 3,
    }) as THREE.DataTexture;

    const middleOf = (texture: THREE.DataTexture): number => {
      const { data, width, height } = texture.image as {
        data: Uint8Array;
        width: number;
        height: number;
      };
      return data[Math.floor(height / 2) * width * 4]!;
    };

    // A higher power keeps more of the sphere dark, pushing the light band up.
    expect(middleOf(biased)).toBeLessThan(middleOf(linear));
    linear.dispose();
    biased.dispose();
  });
});

describe('toneMappingConstant', () => {
  it('maps every name the schema allows onto a three.js constant', () => {
    expect(toneMappingConstant('aces')).toBe(THREE.ACESFilmicToneMapping);
    expect(toneMappingConstant('agx')).toBe(THREE.AgXToneMapping);
    expect(toneMappingConstant('neutral')).toBe(THREE.NeutralToneMapping);
    expect(toneMappingConstant('reinhard')).toBe(THREE.ReinhardToneMapping);
    expect(toneMappingConstant('cineon')).toBe(THREE.CineonToneMapping);
    expect(toneMappingConstant('linear')).toBe(THREE.LinearToneMapping);
    expect(toneMappingConstant('none')).toBe(THREE.NoToneMapping);
  });
});
