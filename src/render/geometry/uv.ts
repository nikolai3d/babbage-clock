/**
 * Texture coordinates and texel density.
 *
 * Every part of the clock is generated in code, and three.js gives each
 * primitive whatever UV parameterisation suited *it* — `LatheGeometry` spans
 * 0…1 around the revolution, `ExtrudeGeometry` writes world millimetres on the
 * cap faces, a merged multi-primitive part has whatever its pieces happened to
 * carry. A tiled Substance material laid over that would repeat at a different
 * rate on every part, which makes `tiling` in a manifest meaningless.
 *
 * ## The convention
 *
 * **One UV unit is {@link SURFACE_UNIT_METRES} of real surface, everywhere.**
 *
 * So a material with `"tiling": [1, 1]` repeats once every metre of surface on
 * the drums, on the case, on the gear faces and on the numerals alike, and
 * `"tiling": [4, 4]` repeats four times as often on all of them. An artist
 * tunes a number once and it means the same thing on every part.
 *
 * The helpers below are the three ways a generator reaches that convention:
 *
 * - {@link normalizedUvToSurface} — the primitive's UVs span 0…1 over a surface
 *   of known size (lathes, cylinders, tori, boxes). Exact and seamless.
 * - {@link metricUvToSurface} — the primitive already writes UVs in metres
 *   (`ExtrudeGeometry` cap faces). A single scale is all that is needed.
 * - {@link boxProjectUv} — the part is a merge of several primitives with
 *   inconsistent UVs. Projects along whichever axis each face most nearly
 *   faces, which is uniform by construction; the price is a seam where a
 *   surface curves past 45 degrees.
 *
 * `docs/materials.md` records the same convention for artists.
 */

import * as THREE from 'three';

/**
 * Metres of surface covered by one UV unit before `tiling` is applied.
 *
 * One metre, deliberately: the app's world unit is the metre (`docs/assets.md`),
 * so a material author reading `"tiling": [2, 2]` can say "twice per metre"
 * without converting anything. How coarse a given material actually is then
 * belongs to that material's manifest, where it can be tuned per surface,
 * rather than being buried in a global constant.
 */
export const SURFACE_UNIT_METRES = 1;

/** Adds a zeroed uv attribute when a geometry has none. */
export function ensureUv(geometry: THREE.BufferGeometry): THREE.BufferAttribute {
  const existing = geometry.getAttribute('uv');
  if (existing) return existing as THREE.BufferAttribute;

  const count = geometry.getAttribute('position').count;
  const attribute = new THREE.BufferAttribute(new Float32Array(count * 2), 2);
  geometry.setAttribute('uv', attribute);
  return attribute;
}

/** Multiplies existing UVs in place. */
export function multiplyUv(
  geometry: THREE.BufferGeometry,
  scaleU: number,
  scaleV: number,
): THREE.BufferGeometry {
  const uv = ensureUv(geometry);
  for (let i = 0; i < uv.count; i += 1) {
    uv.setXY(i, uv.getX(i) * scaleU, uv.getY(i) * scaleV);
  }
  uv.needsUpdate = true;
  return geometry;
}

/**
 * Rescales UVs that span 0…1 over a surface measuring `uMetres` by `vMetres`.
 *
 * This is the exact case for every three.js revolution primitive: the caller
 * knows the circumference and the profile length, which is all the mapping
 * needs.
 */
export function normalizedUvToSurface(
  geometry: THREE.BufferGeometry,
  uMetres: number,
  vMetres: number,
): THREE.BufferGeometry {
  return multiplyUv(geometry, uMetres / SURFACE_UNIT_METRES, vMetres / SURFACE_UNIT_METRES);
}

/** Rescales UVs already expressed in metres — `ExtrudeGeometry` cap faces. */
export function metricUvToSurface(geometry: THREE.BufferGeometry): THREE.BufferGeometry {
  const inverse = 1 / SURFACE_UNIT_METRES;
  return multiplyUv(geometry, inverse, inverse);
}

/**
 * Projects UVs from world position along each vertex's dominant normal axis.
 *
 * The fallback for merged parts (the hinge, the shackle, the screw studs, the
 * escapement) whose pieces carry unrelated parameterisations. Texel density is
 * uniform by construction because the projection is straight from metres.
 */
export function boxProjectUv(geometry: THREE.BufferGeometry): THREE.BufferGeometry {
  if (!geometry.getAttribute('normal')) geometry.computeVertexNormals();

  const position = geometry.getAttribute('position');
  const normal = geometry.getAttribute('normal');
  const uv = ensureUv(geometry);
  const inverse = 1 / SURFACE_UNIT_METRES;

  for (let i = 0; i < position.count; i += 1) {
    const x = position.getX(i);
    const y = position.getY(i);
    const z = position.getZ(i);
    const nx = Math.abs(normal.getX(i));
    const ny = Math.abs(normal.getY(i));
    const nz = Math.abs(normal.getZ(i));

    // Project onto the plane the face most nearly lies in.
    if (nx >= ny && nx >= nz) uv.setXY(i, z * inverse, y * inverse);
    else if (ny >= nz) uv.setXY(i, x * inverse, z * inverse);
    else uv.setXY(i, x * inverse, y * inverse);
  }

  uv.needsUpdate = true;
  return geometry;
}

/**
 * Projects UVs onto the plane perpendicular to one axis, in surface units.
 *
 * Unlike {@link boxProjectUv} the axis is chosen once for the whole part rather
 * than per vertex, so there are no seams where a curving surface crosses 45
 * degrees. That makes it the right tool for a part that is essentially flat —
 * a lid, a disc, a plate — and the wrong one for anything that wraps.
 */
export function planarUv(
  geometry: THREE.BufferGeometry,
  axis: 'x' | 'y' | 'z' = 'y',
): THREE.BufferGeometry {
  const position = geometry.getAttribute('position');
  const uv = ensureUv(geometry);
  const inverse = 1 / SURFACE_UNIT_METRES;

  for (let i = 0; i < position.count; i += 1) {
    const x = position.getX(i);
    const y = position.getY(i);
    const z = position.getZ(i);
    if (axis === 'x') uv.setXY(i, z * inverse, y * inverse);
    else if (axis === 'y') uv.setXY(i, x * inverse, z * inverse);
    else uv.setXY(i, x * inverse, y * inverse);
  }

  uv.needsUpdate = true;
  return geometry;
}

/** Total length of a polyline; the `v` extent of a lathe profile. */
export function polylineLength(points: readonly THREE.Vector2[]): number {
  let total = 0;
  for (let i = 1; i < points.length; i += 1) {
    total += points[i]!.distanceTo(points[i - 1]!);
  }
  return total;
}

/**
 * Applies the surface convention to a `LatheGeometry` built from `profile`.
 *
 * The `u` extent is the circumference at the profile's widest radius and the
 * `v` extent is the profile's own length, so a tall narrow case and a flat
 * bezel ring both come out at the same texel density.
 *
 * **Unless the part is a flat disc.** A lathe's `u` spans one full turn
 * whatever radius it is at, so on a profile that reaches the centre the texture
 * is squeezed into a singularity there and reads as a starburst of radial
 * streaks — which is what the padlock lid looked like. No rescaling fixes that;
 * it is the wrong projection for the shape, and a disc wants a flat one.
 *
 * A profile that reaches the centre but is *deep* — the case shell, a cup — is
 * left cylindrical, because there the wall is the surface anyone looks at and a
 * planar projection would smear it. Only the small closing cap suffers, and it
 * faces away from the camera.
 *
 * Call this in the lathe's own frame, before any rotation: the planar branch
 * projects along the revolution axis, and the UVs then travel with the vertices
 * wherever the part is subsequently placed.
 */
export function latheUvToSurface(
  geometry: THREE.BufferGeometry,
  profile: readonly THREE.Vector2[],
): THREE.BufferGeometry {
  const maxRadius = profile.reduce((max, point) => Math.max(max, point.x), 0);
  const minRadius = profile.reduce((min, point) => Math.min(min, point.x), Infinity);
  const axialExtent =
    profile.reduce((max, point) => Math.max(max, point.y), -Infinity) -
    profile.reduce((min, point) => Math.min(min, point.y), Infinity);

  const closesOnAxis = minRadius <= maxRadius * 0.05;
  const isDisc = axialExtent < maxRadius * 0.35;
  if (closesOnAxis && isDisc) return planarUv(geometry, 'y');

  return normalizedUvToSurface(
    geometry,
    2 * Math.PI * maxRadius,
    Math.max(polylineLength(profile), 1e-6),
  );
}

/**
 * Mean texel density of a geometry, in UV units per metre.
 *
 * Used by the unit tests to assert that every generator lands on the same
 * convention: a part whose density drifts from `1 / SURFACE_UNIT_METRES` will
 * show a differently sized weave than the part next to it.
 */
export function measureTexelDensity(geometry: THREE.BufferGeometry): {
  mean: number;
  min: number;
  max: number;
  samples: number;
} {
  const position = geometry.getAttribute('position') as THREE.BufferAttribute;
  const uv = geometry.getAttribute('uv') as THREE.BufferAttribute | undefined;
  if (!uv) throw new Error('measureTexelDensity: geometry has no uv attribute');

  const index = geometry.getIndex();
  const count = index ? index.count : position.count;
  const at = (i: number): number => (index ? index.getX(i) : i);

  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  const ua = new THREE.Vector2();
  const ub = new THREE.Vector2();
  const uc = new THREE.Vector2();

  let total = 0;
  let samples = 0;
  let min = Infinity;
  let max = 0;

  for (let i = 0; i + 2 < count; i += 3) {
    const ia = at(i);
    const ib = at(i + 1);
    const ic = at(i + 2);
    a.fromBufferAttribute(position, ia);
    b.fromBufferAttribute(position, ib);
    c.fromBufferAttribute(position, ic);
    ua.fromBufferAttribute(uv, ia);
    ub.fromBufferAttribute(uv, ib);
    uc.fromBufferAttribute(uv, ic);

    const worldArea = b.clone().sub(a).cross(c.clone().sub(a)).length() / 2;
    const uvArea = Math.abs((ub.x - ua.x) * (uc.y - ua.y) - (uc.x - ua.x) * (ub.y - ua.y)) / 2;
    // Degenerate slivers dominate the ratio without contributing any visible
    // surface, so they are left out rather than allowed to poison the mean.
    if (worldArea < 1e-9 || uvArea < 1e-12) continue;

    const density = Math.sqrt(uvArea / worldArea);
    total += density;
    samples += 1;
    min = Math.min(min, density);
    max = Math.max(max, density);
  }

  return { mean: samples === 0 ? 0 : total / samples, min, max, samples };
}
