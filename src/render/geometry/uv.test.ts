import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { createGearGeometry } from './gear.js';
import { createHousingParts } from './housing.js';
import { createRingBodyGeometry, createRingNumeralsGeometry } from './ring.js';
import { SURFACE_UNIT_METRES, boxProjectUv, measureTexelDensity } from './uv.js';
import { copperPadlockScene } from '../../scene/scenes/copperPadlock.js';
import type { RingConfig } from '../../scene/types.js';

/**
 * Texture coordinates for the procedural generators.
 *
 * The numeral cases are the substance of this file. Digit glyphs are extruded
 * flat and then *bent* onto the drum, so the UVs `ExtrudeGeometry` wrote
 * describe the flat glyph, not the curved one. Any texture on the `numerals`
 * slot was therefore stretched around the curve — invisible while every
 * material was an untextured placeholder, and glaring the moment one was not.
 *
 * These assertions are the objective half of the fix. The subjective half was
 * looking at the `uv-grid` material on the rendered drum; see
 * `docs/materials.md`.
 */

const rings: RingConfig = copperPadlockScene.rings;

/** UV units per metre, which the convention fixes at `1 / SURFACE_UNIT_METRES`. */
const EXPECTED_DENSITY = 1 / SURFACE_UNIT_METRES;

describe('ring numeral UVs', () => {
  const geometry = createRingNumeralsGeometry(rings);

  it('has texture coordinates at all', () => {
    expect(geometry.getAttribute('uv')).toBeDefined();
  });

  /**
   * The whole point of the fix: one metre of drum surface is the same number of
   * UV units wherever it is measured. A mapping inherited from the flat
   * extrusion fails this — the glyph faces end up denser than the surface they
   * were bent onto, and by a different amount for every digit, because each is
   * bent about a different part of the circle.
   */
  it('carries uniform texel density across every glyph', () => {
    const density = surfaceDensity(geometry, rings);

    expect(density.samples).toBeGreaterThan(100);
    expect(density.mean).toBeCloseTo(EXPECTED_DENSITY, 1);
    // Uniform to better than a tenth of a percent across ten glyphs, each bent
    // about a different part of the circle. It is exact rather than fitted
    // because the bend is known analytically at the point the UVs are written.
    expect(density.max / density.min).toBeLessThan(1.005);
    // Just under 2.0 rather than exactly: arc length is measured at the drum
    // surface while the glyph face stands a millimetre proud of it, so a metre
    // of face covers marginally less than a metre of drum. That is the relief
    // being real, not a distortion.
    expect(density.mean).toBeLessThan(EXPECTED_DENSITY);
    expect(density.mean).toBeGreaterThan(EXPECTED_DENSITY * 0.98);
  });

  /**
   * Non-square texels are what "distorted" looks like on screen: a checker
   * comes out as rectangles. Measured directly by comparing how far the UVs
   * travel per metre along the drum axis against per metre around it.
   */
  it('maps the two surface directions at the same scale', () => {
    const { alongAxis, aroundDrum } = measureDirectionalDensity(geometry, rings);

    expect(alongAxis).toBeCloseTo(EXPECTED_DENSITY, 1);
    expect(aroundDrum).toBeCloseTo(EXPECTED_DENSITY, 1);
    expect(alongAxis / aroundDrum).toBeCloseTo(1, 1);
  });

  /**
   * The numerals and the drum beneath them are one continuous cylindrical
   * frame, so `u` covers the circumference exactly once across the digit set. A
   * material tiled over both therefore lines up instead of shearing at the
   * glyph edges.
   */
  it('spans exactly one circumference of the drum', () => {
    const uv = geometry.getAttribute('uv');
    let min = Infinity;
    let max = -Infinity;
    for (let i = 0; i < uv.count; i += 1) {
      min = Math.min(min, uv.getX(i));
      max = Math.max(max, uv.getX(i));
    }

    const circumference = (2 * Math.PI * rings.radius) / SURFACE_UNIT_METRES;
    // One glyph height short of a full turn: the last digit's trailing edge is
    // where the first digit's leading edge already is.
    expect(max - min).toBeGreaterThan(circumference * 0.85);
    expect(max - min).toBeLessThanOrEqual(circumference + 1e-6);
  });

  it('scales with the drum, not with the digit count', () => {
    const bigger = createRingNumeralsGeometry({ ...rings, radius: 2.5, thickness: 0.9 });
    const density = surfaceDensity(bigger, { ...rings, radius: 2.5, thickness: 0.9 });

    expect(density.mean).toBeCloseTo(EXPECTED_DENSITY, 1);
    expect(density.max / density.min).toBeLessThan(1.005);
    bigger.dispose();
  });

  geometry.dispose();
});

describe('texel density across the generators', () => {
  /**
   * `tiling: [1, 1]` has to mean the same thing on the drum, the case and a
   * gear face, or an artist tuning one number is tuning it for one part.
   */
  it('puts the drum body on the shared convention', () => {
    const body = createRingBodyGeometry(rings);
    const density = measureTexelDensity(body);

    // The outer face is exact; the bore and the end faces are stretched by the
    // lathe's own parameterisation (they revolve at a smaller radius while `u`
    // still spans the full turn), which pulls the mean up. Neither is a surface
    // the clock is read from.
    expect(density.mean).toBeGreaterThan(EXPECTED_DENSITY * 0.9);
    expect(density.mean).toBeLessThan(EXPECTED_DENSITY * 2.5);
    body.dispose();
  });

  it('puts gear faces on the shared convention', () => {
    const gear = createGearGeometry({ teeth: 24, radius: 0.66, thickness: 0.13 });
    const density = measureTexelDensity(gear);

    // The flat faces are exact; the tooth flanks and the rim bevel lean away
    // from the axis they are projected along and are foreshortened by up to
    // their cosine, which is the accepted cost of box projection and pulls the
    // mean a little under.
    expect(density.max).toBeCloseTo(EXPECTED_DENSITY, 5);
    expect(density.mean).toBeGreaterThan(EXPECTED_DENSITY * 0.8);
    expect(density.mean).toBeLessThanOrEqual(EXPECTED_DENSITY);
    gear.dispose();
  });

  it('gives every housing part usable coordinates', () => {
    const parts = createHousingParts({ innerRadius: 2.4, depth: 2.2, radialSegments: 24 });

    for (const part of parts) {
      const uv = part.geometry.getAttribute('uv');
      expect(uv, `${part.name} has no uv attribute`).toBeDefined();

      const density = measureTexelDensity(part.geometry);
      // Wider bounds than the drum: the box projection behind the merged parts
      // foreshortens a face as it turns away from the axis it is projected
      // along, which is the accepted cost of a uniform mapping over an
      // arbitrary merged solid.
      expect(density.mean, `${part.name} density`).toBeGreaterThan(EXPECTED_DENSITY * 0.3);
      expect(density.mean, `${part.name} density`).toBeLessThan(EXPECTED_DENSITY * 3);
      part.geometry.dispose();
    }
  });
});

describe('boxProjectUv', () => {
  it('projects a face along the axis it points down', () => {
    const box = boxProjectUv(new THREE.BoxGeometry(1, 1, 1));
    const density = measureTexelDensity(box);

    expect(density.mean).toBeCloseTo(EXPECTED_DENSITY, 5);
    box.dispose();
  });

  it('adds coordinates to a geometry that had none', () => {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute(
      'position',
      new THREE.BufferAttribute(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), 3),
    );

    expect(geometry.getAttribute('uv')).toBeUndefined();
    boxProjectUv(geometry);
    expect(geometry.getAttribute('uv')?.count).toBe(3);
    geometry.dispose();
  });
});

/** Distance of a point from the ring axis. */
function radiusOf(point: THREE.Vector3, config: RingConfig): number {
  if (config.axis === 'x') return Math.hypot(point.y, point.z);
  if (config.axis === 'y') return Math.hypot(point.x, point.z);
  return Math.hypot(point.x, point.y);
}

/**
 * Texel density over the triangles that actually face outward.
 *
 * The extrusion walls of a raised glyph stand perpendicular to the drum, and a
 * cylindrical projection has nothing to say about them — they collapse to a
 * sliver of UV space by definition. What the fix is about is the faces a viewer
 * reads the digit from, so those are what is measured.
 */
function surfaceDensity(
  geometry: THREE.BufferGeometry,
  config: RingConfig,
): { mean: number; min: number; max: number; samples: number } {
  const position = geometry.getAttribute('position');
  const uv = geometry.getAttribute('uv') as THREE.BufferAttribute;
  const index = geometry.getIndex();
  const count = index ? index.count : position.count;
  const at = (i: number): number => (index ? index.getX(i) : i);

  const points = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
  const uvs = [new THREE.Vector2(), new THREE.Vector2(), new THREE.Vector2()];
  const faceNormal = new THREE.Vector3();
  const radial = new THREE.Vector3();

  let total = 0;
  let samples = 0;
  let min = Infinity;
  let max = 0;

  for (let i = 0; i + 2 < count; i += 3) {
    for (let corner = 0; corner < 3; corner += 1) {
      const vertex = at(i + corner);
      points[corner]!.fromBufferAttribute(position, vertex);
      uvs[corner]!.fromBufferAttribute(uv, vertex);
    }

    // The triangle's *geometric* orientation, not its shading normal. Those
    // used to be the same thing, because normals were rebuilt with three's
    // `computeVertexNormals` over non-indexed geometry — which can only write
    // face normals. Now that the relief is smooth-shaded across its curves, a
    // shading normal says where a face points *visually*, and a skewed sliver
    // borrows its neighbours' direction. Only the cross product still says
    // which way the triangle itself faces, which is what this filter means.
    faceNormal
      .copy(points[1]!)
      .sub(points[0]!)
      .cross(new THREE.Vector3().copy(points[2]!).sub(points[0]!))
      .normalize();

    radial.copy(points[0]!);
    radial[config.axis] = 0;
    if (radial.lengthSq() < 1e-12) continue;
    radial.normalize();
    // The faces a digit is read from, and only those. The walls of the raised
    // stroke stand perpendicular to the drum, where a cylindrical projection
    // has nothing to say; admitting them would be measuring the mapping
    // somewhere it does not claim to be defined.
    if (faceNormal.dot(radial) < 0.999) continue;

    const worldArea =
      points[1]!.clone().sub(points[0]!).cross(points[2]!.clone().sub(points[0]!)).length() / 2;
    const uvArea =
      Math.abs(
        (uvs[1]!.x - uvs[0]!.x) * (uvs[2]!.y - uvs[0]!.y) -
          (uvs[2]!.x - uvs[0]!.x) * (uvs[1]!.y - uvs[0]!.y),
      ) / 2;
    if (worldArea < 1e-9 || uvArea < 1e-12) continue;

    const density = Math.sqrt(uvArea / worldArea);
    total += density;
    samples += 1;
    min = Math.min(min, density);
    max = Math.max(max, density);
  }

  return { mean: samples === 0 ? 0 : total / samples, min, max, samples };
}

/**
 * How far the UVs travel per metre, measured separately along the ring axis and
 * around the drum.
 *
 * Done by triangle edge rather than by area: area alone cannot tell a square
 * texel from a rectangular one of the same size, and a rectangular one is
 * exactly what a mapping inherited from the flat extrusion produces.
 */
function measureDirectionalDensity(
  geometry: THREE.BufferGeometry,
  config: RingConfig,
): { alongAxis: number; aroundDrum: number } {
  const position = geometry.getAttribute('position');
  const uv = geometry.getAttribute('uv');
  const index = geometry.getIndex();
  const count = index ? index.count : position.count;
  const at = (i: number): number => (index ? index.getX(i) : i);

  let axialUv = 0;
  let axialWorld = 0;
  let hoopUv = 0;
  let hoopWorld = 0;

  const a = new THREE.Vector3();
  const b = new THREE.Vector3();

  for (let i = 0; i + 2 < count; i += 3) {
    for (const [p, q] of [
      [0, 1],
      [1, 2],
      [2, 0],
    ] as const) {
      const ia = at(i + p);
      const ib = at(i + q);
      a.fromBufferAttribute(position, ia);
      b.fromBufferAttribute(position, ib);

      const worldAxial = Math.abs(b[config.axis] - a[config.axis]);
      const worldTotal = a.distanceTo(b);
      if (worldTotal < 1e-6) continue;
      // Edges that dive through the relief rather than running along the drum
      // surface are not part of the mapping being measured: a cylindrical
      // projection collapses them by construction.
      if (Math.abs(radiusOf(b, config) - radiusOf(a, config)) > worldTotal * 0.02) continue;

      const du = Math.abs(uv.getX(ib) - uv.getX(ia));
      const dv = Math.abs(uv.getY(ib) - uv.getY(ia));

      // Only edges that run cleanly along one direction, so the two are never
      // measured through each other.
      if (worldAxial > worldTotal * 0.98) {
        axialWorld += worldTotal;
        axialUv += dv;
      } else if (worldAxial < worldTotal * 0.02) {
        hoopWorld += worldTotal;
        hoopUv += du;
      }
    }
  }

  return {
    alongAxis: axialUv / axialWorld,
    aroundDrum: hoopUv / hoopWorld,
  };
}
