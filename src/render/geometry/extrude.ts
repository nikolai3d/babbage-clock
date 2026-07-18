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
import { ensureUv } from './uv.js';
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
 *
 * The callback is handed the vertex's UV alongside its position, and for the
 * same reason: `ExtrudeGeometry` writes UVs for the *flat* profile, so once the
 * profile is bent they describe a surface that no longer exists. Only the
 * caller knows the mapping, so only the caller can restate them — see
 * `createRingNumeralsGeometry`.
 */
/**
 * Splits triangles until no edge spans more than `maxSpanY` along y.
 *
 * The counterpart to outline subdivision for a geometry that is about to be
 * bent around y (see `createRingNumeralsGeometry`). Subdividing the outline is
 * not sufficient on its own: earcut drops collinear vertices when it
 * triangulates the end caps, so a rectangular stroke's cap keeps a diagonal
 * spanning the full glyph height no matter how finely its outline is divided —
 * and that one edge is enough to sink the middle of the face below the drum.
 * Splitting at the triangle level bounds every edge the cap actually has.
 *
 * Expects non-indexed geometry (which is what `ExtrudeGeometry` produces).
 * Positions and uvs are interpolated; normals are left to the caller because
 * the bend that follows recomputes them anyway.
 */
export function subdivideTrianglesY(
  geometry: THREE.BufferGeometry,
  maxSpanY: number,
): THREE.BufferGeometry {
  if (geometry.getIndex() !== null) {
    throw new Error('subdivideTrianglesY: expected non-indexed geometry');
  }
  if (!(maxSpanY > 0)) {
    throw new Error(`subdivideTrianglesY: maxSpanY must be > 0, got ${maxSpanY}`);
  }

  const position = geometry.getAttribute('position');
  const uv = geometry.getAttribute('uv');

  type Vertex = { p: [number, number, number]; t: [number, number] };
  const vertexAt = (i: number): Vertex => ({
    p: [position.getX(i), position.getY(i), position.getZ(i)],
    t: uv ? [uv.getX(i), uv.getY(i)] : [0, 0],
  });
  const midpoint = (a: Vertex, b: Vertex): Vertex => ({
    p: [(a.p[0] + b.p[0]) / 2, (a.p[1] + b.p[1]) / 2, (a.p[2] + b.p[2]) / 2],
    t: [(a.t[0] + b.t[0]) / 2, (a.t[1] + b.t[1]) / 2],
  });

  const out: Vertex[] = [];
  const stack: [Vertex, Vertex, Vertex][] = [];
  for (let i = 0; i < position.count; i += 3) {
    stack.push([vertexAt(i), vertexAt(i + 1), vertexAt(i + 2)]);
  }

  // Cross-product magnitude; near-zero for the degenerate slivers earcut emits
  // when an outline carries collinear (subdivided) points. Those would get
  // zero-length normals from computeVertexNormals later, so they are dropped.
  //
  // The threshold is far above float epsilon on purpose: positions are stored
  // as float32 and later bent, and a sliver that squeaks past a tiny threshold
  // here can still quantise to zero area afterwards. 1e-7 m^2 is orders of
  // magnitude below anything a glyph legitimately produces (~1e-4 and up) and
  // orders above quantisation noise (~1e-9), so the gap is safe on both sides.
  const area = ([a, b, c]: [Vertex, Vertex, Vertex]): number => {
    const ab = [b.p[0] - a.p[0], b.p[1] - a.p[1], b.p[2] - a.p[2]];
    const ac = [c.p[0] - a.p[0], c.p[1] - a.p[1], c.p[2] - a.p[2]];
    const cx = ab[1]! * ac[2]! - ab[2]! * ac[1]!;
    const cy = ab[2]! * ac[0]! - ab[0]! * ac[2]!;
    const cz = ab[0]! * ac[1]! - ab[1]! * ac[0]!;
    return Math.hypot(cx, cy, cz) / 2;
  };

  while (stack.length > 0) {
    const triangle = stack.pop()!;
    if (area(triangle) < 1e-7) continue;
    const spans = triangle.map((vertex, corner) =>
      Math.abs(vertex.p[1] - triangle[(corner + 1) % 3]!.p[1]),
    );
    const widest = spans.indexOf(Math.max(...spans));
    if (spans[widest]! <= maxSpanY) {
      out.push(...triangle);
      continue;
    }
    // Split the widest edge; winding order is preserved in both halves.
    const a = triangle[widest]!;
    const b = triangle[(widest + 1) % 3]!;
    const c = triangle[(widest + 2) % 3]!;
    const m = midpoint(a, b);
    stack.push([a, m, c], [m, b, c]);
  }

  const positions = new Float32Array(out.length * 3);
  const uvs = new Float32Array(out.length * 2);
  for (let i = 0; i < out.length; i += 1) {
    positions.set(out[i]!.p, i * 3);
    uvs.set(out[i]!.t, i * 2);
  }

  const result = new THREE.BufferGeometry();
  result.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  if (uv) result.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  geometry.dispose();
  return result;
}

export function deformPositions(
  geometry: THREE.BufferGeometry,
  transform: (point: THREE.Vector3, uv: THREE.Vector2) => void,
): THREE.BufferGeometry {
  const position = geometry.getAttribute('position');
  const uvAttribute = ensureUv(geometry);
  const vertex = new THREE.Vector3();
  const uv = new THREE.Vector2();

  for (let i = 0; i < position.count; i += 1) {
    vertex.fromBufferAttribute(position, i);
    uv.fromBufferAttribute(uvAttribute, i);
    transform(vertex, uv);
    position.setXYZ(i, vertex.x, vertex.y, vertex.z);
    uvAttribute.setXY(i, uv.x, uv.y);
  }

  position.needsUpdate = true;
  uvAttribute.needsUpdate = true;
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();
  return geometry;
}
