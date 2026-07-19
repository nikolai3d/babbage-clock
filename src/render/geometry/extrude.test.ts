import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { DEFAULT_CREASE_ANGLE, computeCreasedVertexNormals } from './extrude.js';

/**
 * Builds a non-indexed geometry from raw triangle corners.
 *
 * Non-indexed on purpose: it is the shape `ExtrudeGeometry` and
 * `subdivideTrianglesY` hand on, and the shape three's own
 * `computeVertexNormals` cannot smooth.
 */
function triangles(...corners: [number, number, number][]): THREE.BufferGeometry {
  const positions = new Float32Array(corners.length * 3);
  corners.forEach((corner, i) => positions.set(corner, i * 3));
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  return geometry;
}

/** A unit quad in the z = 0 plane spanning y in [0, 1]. Face normal +z. */
const FLAT_QUAD: [number, number, number][] = [
  [0, 0, 0],
  [1, 0, 0],
  [1, 1, 0],
  [0, 0, 0],
  [1, 1, 0],
  [0, 1, 0],
];

/**
 * A unit quad hinged off the y = 0 edge by `angle`, spanning y in [-1, 0].
 * Face normal (0, sin angle, cos angle) — so it meets {@link FLAT_QUAD} at
 * exactly `angle`.
 */
function hingedQuad(angle: number): [number, number, number][] {
  const s = Math.sin(angle);
  const c = Math.cos(angle);
  return [
    [0, 0, 0],
    [1, -c, s],
    [1, 0, 0],
    [0, 0, 0],
    [0, -c, s],
    [1, -c, s],
  ];
}

function normalAt(geometry: THREE.BufferGeometry, vertex: number): THREE.Vector3 {
  return new THREE.Vector3().fromBufferAttribute(geometry.getAttribute('normal'), vertex);
}

describe('computeCreasedVertexNormals', () => {
  it('leaves a flat face flat', () => {
    const geometry = triangles(...FLAT_QUAD);
    computeCreasedVertexNormals(geometry);

    for (let i = 0; i < 6; i += 1) {
      // Component-wise: `toArray` can hand back a signed zero, which strict
      // equality treats as distinct from 0.
      expect(normalAt(geometry, i).dot(new THREE.Vector3(0, 0, 1))).toBeCloseTo(1, 6);
    }
    geometry.dispose();
  });

  it('smooths a join gentler than the crease angle', () => {
    const angle = Math.PI / 6; // 30 degrees, well inside the 60 degree threshold
    const geometry = triangles(...FLAT_QUAD, ...hingedQuad(angle));
    computeCreasedVertexNormals(geometry);

    // The two quads have equal area, so the seam normal is the exact bisector.
    const bisector = new THREE.Vector3(0, Math.sin(angle / 2), Math.cos(angle / 2));
    // Vertex 0 belongs to the flat quad, vertex 6 to the hinged one; both sit
    // on the seam at the origin and must now agree.
    for (const vertex of [0, 6]) {
      expect(normalAt(geometry, vertex).dot(bisector)).toBeCloseTo(1, 6);
    }
    geometry.dispose();
  });

  it('keeps a join sharper than the crease angle sharp', () => {
    const angle = Math.PI / 2; // the numeral relief edge: face meets extruded side
    const geometry = triangles(...FLAT_QUAD, ...hingedQuad(angle));
    computeCreasedVertexNormals(geometry);

    // Each side of the seam keeps its own face normal — no rounding of the edge.
    expect(normalAt(geometry, 0).dot(new THREE.Vector3(0, 0, 1))).toBeCloseTo(1, 6);
    const hinged = normalAt(geometry, 6);
    expect(hinged.y).toBeCloseTo(1, 6);
    expect(hinged.z).toBeCloseTo(0, 6);
    geometry.dispose();
  });

  it('honours an explicit crease angle', () => {
    const angle = Math.PI / 4; // 45 degrees
    const sharp = triangles(...FLAT_QUAD, ...hingedQuad(angle));
    computeCreasedVertexNormals(sharp, Math.PI / 8); // 22.5 degree threshold
    expect(normalAt(sharp, 0).dot(new THREE.Vector3(0, 0, 1))).toBeCloseTo(1, 6);

    const smooth = triangles(...FLAT_QUAD, ...hingedQuad(angle));
    computeCreasedVertexNormals(smooth, Math.PI / 3); // 60 degree threshold
    expect(normalAt(smooth, 0).z).toBeLessThan(1);

    sharp.dispose();
    smooth.dispose();
  });

  it('is what three.js cannot do on non-indexed geometry', () => {
    // The mechanism behind the reported bug, pinned: `computeVertexNormals`
    // has no vertex sharing to work with here, so it writes the face normal to
    // all three corners of every triangle — flat shading by construction.
    const angle = Math.PI / 6;
    const three = triangles(...FLAT_QUAD, ...hingedQuad(angle));
    three.computeVertexNormals();
    expect(normalAt(three, 0).dot(new THREE.Vector3(0, 0, 1))).toBeCloseTo(1, 6);

    const creased = triangles(...FLAT_QUAD, ...hingedQuad(angle));
    computeCreasedVertexNormals(creased);
    expect(normalAt(creased, 0).z).toBeLessThan(1);

    three.dispose();
    creased.dispose();
  });

  it('survives degenerate triangles without emitting NaN', () => {
    const geometry = triangles(
      ...FLAT_QUAD,
      // A zero-area sliver of the kind earcut emits on collinear points.
      [0, 0, 0],
      [1, 0, 0],
      [2, 0, 0],
    );
    computeCreasedVertexNormals(geometry);

    const normals = geometry.getAttribute('normal').array;
    for (const value of normals) expect(Number.isFinite(value)).toBe(true);
    geometry.dispose();
  });

  it('rejects indexed geometry, which cannot carry per-corner normals', () => {
    const geometry = triangles(...FLAT_QUAD);
    geometry.setIndex([0, 1, 2, 3, 4, 5]);
    expect(() => computeCreasedVertexNormals(geometry)).toThrow(/non-indexed/);
    geometry.dispose();
  });

  it('exposes a crease angle between the glyph pipeline’s two extremes', () => {
    // Round stroke caps step 45 degrees; the relief edge is 90.
    expect(DEFAULT_CREASE_ANGLE).toBeGreaterThan((45 * Math.PI) / 180);
    expect(DEFAULT_CREASE_ANGLE).toBeLessThan((90 * Math.PI) / 180);
  });
});
