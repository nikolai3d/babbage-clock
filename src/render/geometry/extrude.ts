/**
 * The bridge between pure 2D outlines (`src/geometry/`) and three.js geometry.
 *
 * Nothing above this file imports three.js; nothing below it knows about
 * contours. Keeping the conversion in one place also keeps the disposal story
 * simple: every intermediate geometry created while merging is released here,
 * and callers only ever own the single geometry they are handed.
 */

import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { Contour, Outline } from '../../geometry/types.js';

export interface ExtrudeOptions {
  /** Extrusion depth along +Z, measured from the profile plane. */
  readonly depth: number;
  /** Bevel size in metres; 0 disables bevelling. */
  readonly bevel?: number;
  readonly bevelSegments?: number;
  /** Centres the extrusion on z = 0 rather than starting at it. */
  readonly centered?: boolean;
}

function toPath(contour: Contour): THREE.Vector2[] {
  return contour.map((point) => new THREE.Vector2(point.x, point.y));
}

/** A single outline as a three.js `Shape`, holes included. */
export function outlineToShape(outline: Outline): THREE.Shape {
  const shape = new THREE.Shape(toPath(outline.contour));
  for (const hole of outline.holes) shape.holes.push(new THREE.Path(toPath(hole)));
  return shape;
}

/**
 * Extrudes outlines into one geometry.
 *
 * Outlines are extruded as a single `ExtrudeGeometry` where possible; the
 * result is one draw call regardless of how many separate strokes or cutouts
 * went in. Overlapping outlines are fine — they are opaque solids of the same
 * material, so no 2D boolean is needed to hide the seams.
 */
export function extrudeOutlines(
  outlines: readonly Outline[],
  options: ExtrudeOptions,
): THREE.BufferGeometry {
  if (outlines.length === 0) {
    throw new Error('extrudeOutlines: nothing to extrude');
  }

  const bevel = options.bevel ?? 0;
  const shapes = outlines.map(outlineToShape);
  const geometry = new THREE.ExtrudeGeometry(shapes, {
    depth: options.depth,
    bevelEnabled: bevel > 0,
    bevelThickness: bevel,
    bevelSize: bevel,
    // Negative offset chamfers the end faces inwards instead of bulging the
    // body outwards, so a bevelled part keeps the outer size it was asked for.
    bevelOffset: -bevel,
    bevelSegments: Math.max(1, options.bevelSegments ?? 1),
    curveSegments: 1,
  });

  if (options.centered) geometry.translate(0, 0, -options.depth / 2);
  return geometry;
}

/**
 * Merges geometries into one and disposes the inputs.
 *
 * Anything that ends up on screen as a single mesh should go through here:
 * seventy digit glyphs merged into one buffer is seventy fewer draw calls, and
 * the inputs never survive to leak.
 */
export function mergeAndDispose(geometries: THREE.BufferGeometry[]): THREE.BufferGeometry {
  if (geometries.length === 0) throw new Error('mergeAndDispose: nothing to merge');
  if (geometries.length === 1) return geometries[0]!;

  const merged = mergeGeometries(geometries, false);
  for (const geometry of geometries) geometry.dispose();
  if (!merged) {
    throw new Error('mergeAndDispose: geometries have incompatible attributes');
  }
  return merged;
}

/**
 * Rewrites every vertex position through `transform`, then rebuilds normals.
 *
 * Used to bend flat extruded glyphs onto a cylinder. Normals must be recomputed
 * rather than rotated because the mapping is not rigid.
 */
export function deformPositions(
  geometry: THREE.BufferGeometry,
  transform: (point: THREE.Vector3) => void,
): THREE.BufferGeometry {
  const position = geometry.getAttribute('position');
  const vertex = new THREE.Vector3();
  for (let i = 0; i < position.count; i += 1) {
    vertex.fromBufferAttribute(position, i);
    transform(vertex);
    position.setXYZ(i, vertex.x, vertex.y, vertex.z);
  }
  position.needsUpdate = true;
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();
  return geometry;
}
