import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { createGearGeometry, defaultSpokeStyleFor } from './gear.js';
import { createHousingParts, validateHousingParams } from './housing.js';
import {
  createRingBodyGeometry,
  createRingNumeralsGeometry,
  createSeparatorGlyphGeometry,
} from './ring.js';
import {
  digitAngle,
  readingAngleForAxis,
  ringPlaneAxes,
  type SeparatorGlyph,
} from '../../geometry/ringLayout.js';
import { copperPadlockScene } from '../../scene/scenes/copperPadlock.js';
import { slateOrreryScene } from '../../scene/scenes/slateOrrery.js';
import { MATERIAL_SLOTS, type RingConfig } from '../../scene/types.js';

/**
 * Geometry construction needs no GL context, so the generators are testable
 * headlessly. Pixels are the screenshot harness's problem.
 */

function positions(geometry: THREE.BufferGeometry): THREE.Vector3[] {
  const attribute = geometry.getAttribute('position');
  const points: THREE.Vector3[] = [];
  for (let i = 0; i < attribute.count; i += 1) {
    points.push(new THREE.Vector3().fromBufferAttribute(attribute, i));
  }
  return points;
}

function expectFinite(geometry: THREE.BufferGeometry): void {
  const position = geometry.getAttribute('position');
  const normal = geometry.getAttribute('normal');
  expect(position.count).toBeGreaterThan(0);
  expect(normal.count).toBe(position.count);

  for (let i = 0; i < position.count; i += 1) {
    expect(Number.isFinite(position.getX(i))).toBe(true);
    expect(Number.isFinite(position.getY(i))).toBe(true);
    expect(Number.isFinite(position.getZ(i))).toBe(true);
    const length = Math.hypot(normal.getX(i), normal.getY(i), normal.getZ(i));
    // Degenerate triangles leave zero-length normals, which shade as black.
    expect(length).toBeGreaterThan(0.9);
    expect(length).toBeLessThan(1.1);
  }
}

describe('createGearGeometry', () => {
  it('spins about +Y with the requested face width', () => {
    const geometry = createGearGeometry({ teeth: 18, radius: 0.62, thickness: 0.12 });
    geometry.computeBoundingBox();
    const box = geometry.boundingBox!;

    expect(box.max.y - box.min.y).toBeCloseTo(0.12, 3);
    expect(box.max.x).toBeLessThanOrEqual(0.62 * 1.12);
    expect(box.max.z).toBeLessThanOrEqual(0.62 * 1.12);
    // Centred, so the caller can position it by its axis.
    expect(box.max.y + box.min.y).toBeCloseTo(0, 6);
    geometry.dispose();
  });

  it('produces clean geometry across the whole parameter range', () => {
    const cases = [
      { teeth: 8, radius: 0.1, thickness: 0.02, spokeStyle: 'spoke5' as const },
      { teeth: 10, radius: 0.34, thickness: 0.1, spokeStyle: 'crescent' as const },
      { teeth: 24, radius: 0.8, thickness: 0.14, spokeStyle: 'spoke6' as const },
      { teeth: 60, radius: 4, thickness: 1, spokeStyle: 'solid' as const },
    ];
    for (const params of cases) {
      const geometry = createGearGeometry(params);
      expectFinite(geometry);
      geometry.dispose();
    }
  });

  it('builds every wheel the shipped scenes ask for', () => {
    for (const scene of [copperPadlockScene, slateOrreryScene]) {
      scene.gears.forEach((spec, index) => {
        const geometry = createGearGeometry({
          teeth: spec.teeth,
          radius: spec.radius,
          thickness: spec.thickness,
          spokeStyle: defaultSpokeStyleFor(index, spec.teeth),
        });
        expectFinite(geometry);
        geometry.dispose();
      });
    }
  });

  it('rejects a zero-thickness wheel instead of emitting a flat sheet', () => {
    expect(() => createGearGeometry({ teeth: 12, radius: 1, thickness: 0 })).toThrow(/thickness/);
  });
});

describe('defaultSpokeStyleFor', () => {
  it('is deterministic, so a scene always looks the same', () => {
    expect(defaultSpokeStyleFor(0, 18)).toBe(defaultSpokeStyleFor(0, 18));
    expect(defaultSpokeStyleFor(0, 18)).not.toBe(defaultSpokeStyleFor(1, 18));
  });

  it('leaves high tooth counts solid, where spokes would be invisible anyway', () => {
    expect(defaultSpokeStyleFor(0, 48)).toBe('solid');
  });
});

describe('createRingBodyGeometry', () => {
  it('matches the configured radius and width on the configured axis', () => {
    const config = copperPadlockScene.rings;
    const geometry = createRingBodyGeometry(config);
    geometry.computeBoundingBox();
    const box = geometry.boundingBox!;

    expect(box.max.x - box.min.x).toBeCloseTo(config.thickness, 6);
    expect(box.max.y).toBeCloseTo(config.radius, 6);
    expect(box.max.z).toBeCloseTo(config.radius, 6);
    expectFinite(geometry);
    geometry.dispose();
  });

  it('follows the axis the scene chose', () => {
    for (const axis of ['x', 'y', 'z'] as const) {
      const geometry = createRingBodyGeometry({ ...copperPadlockScene.rings, axis });
      geometry.computeBoundingBox();
      const size = geometry.boundingBox!.getSize(new THREE.Vector3());
      expect(size[axis]).toBeCloseTo(copperPadlockScene.rings.thickness, 6);
      geometry.dispose();
    }
  });

  it('points its outer surface outwards', () => {
    const config = copperPadlockScene.rings;
    const geometry = createRingBodyGeometry(config);
    const position = geometry.getAttribute('position');
    const normal = geometry.getAttribute('normal');

    let checked = 0;
    for (let i = 0; i < position.count; i += 1) {
      const y = position.getY(i);
      const z = position.getZ(i);
      const r = Math.hypot(y, z);
      if (Math.abs(r - config.radius) > 1e-6) continue;
      const outward = (normal.getY(i) * y + normal.getZ(i) * z) / r;
      expect(outward).toBeGreaterThan(0.5);
      checked += 1;
    }
    expect(checked).toBeGreaterThan(0);
    geometry.dispose();
  });

  it('scales with the config rather than baking in a fixed drum', () => {
    const small = createRingBodyGeometry({ ...copperPadlockScene.rings, radius: 0.4 });
    const large = createRingBodyGeometry({ ...copperPadlockScene.rings, radius: 2.4 });
    small.computeBoundingSphere();
    large.computeBoundingSphere();
    expect(large.boundingSphere!.radius).toBeGreaterThan(small.boundingSphere!.radius * 4);
    small.dispose();
    large.dispose();
  });
});

describe('createRingNumeralsGeometry', () => {
  const config = copperPadlockScene.rings;

  it('wraps every digit onto the drum surface', () => {
    const geometry = createRingNumeralsGeometry(config);
    expectFinite(geometry);

    for (const point of positions(geometry)) {
      const radius = Math.hypot(point.y, point.z);
      // Sunk slightly into the drum at the base, standing proud at the face.
      expect(radius).toBeGreaterThan(config.radius * 0.95);
      expect(radius).toBeLessThan(config.radius * 1.05);
      expect(Math.abs(point.x)).toBeLessThan(config.thickness / 2);
    }
    geometry.dispose();
  });

  it("keeps every face on the drum's curve — straight strokes must not sag", () => {
    // The bend is exact per vertex; faces between vertices are chords. Without
    // subdivision, a full-height straight stroke sagged ~2x the entire relief
    // below the arc through its endpoints, sinking the middles of 1, 7 and 4
    // into the drum. Walk every edge of the built geometry and bound the
    // mid-edge sag to a small fraction of the relief.
    const geometry = createRingNumeralsGeometry(config);
    const relief = Math.max(config.radius * 0.012, 0.024); // matches the builder's default floor
    // Extrusions are non-indexed: consecutive position triples are triangles.
    const pos = geometry.getAttribute('position');

    let worst = 0;
    for (let i = 0; i < pos.count; i += 3) {
      for (const [a, b] of [
        [i, i + 1],
        [i + 1, i + 2],
        [i + 2, i],
      ] as const) {
        const ra = Math.hypot(pos.getY(a), pos.getZ(a));
        const rb = Math.hypot(pos.getY(b), pos.getZ(b));
        const rm = Math.hypot((pos.getY(a) + pos.getY(b)) / 2, (pos.getZ(a) + pos.getZ(b)) / 2);
        worst = Math.max(worst, Math.min(ra, rb) - rm);
      }
    }

    expect(worst).toBeLessThanOrEqual(relief * 0.12);
    geometry.dispose();
  });

  it('puts the first digit on the reading line', () => {
    const geometry = createRingNumeralsGeometry(config, { digits: [7] });
    const reading = readingAngleForAxis(config.axis);
    const [uAxis, vAxis] = ringPlaneAxes(config.axis);

    // The glyph straddles the reading line: its extreme angles must bracket it.
    const angles = positions(geometry).map((p) => Math.atan2(p[vAxis], p[uAxis]));
    expect(Math.min(...angles)).toBeLessThan(reading);
    expect(Math.max(...angles)).toBeGreaterThan(reading);
    geometry.dispose();
  });

  it('spaces the digits by the step angle', () => {
    const geometry = createRingNumeralsGeometry(config, { digits: [0, 5] });
    const reading = readingAngleForAxis(config.axis);
    const [uAxis, vAxis] = ringPlaneAxes(config.axis);

    // Digit 5 of a two-digit set sits half a turn from digit 0.
    const angles = positions(geometry).map((p) => Math.atan2(p[vAxis], p[uAxis]));
    const opposite = digitAngle(1, 2, reading);
    const near = angles.filter((a) => Math.abs(Math.cos(a - opposite)) > 0.99);
    expect(near.length).toBeGreaterThan(0);
    geometry.dispose();
  });

  it('honours a digit set that is not 0-9', () => {
    const three = createRingNumeralsGeometry(config, { digits: [1, 2, 3] });
    const ten = createRingNumeralsGeometry(config);
    expect(three.getAttribute('position').count).toBeLessThan(ten.getAttribute('position').count);
    three.dispose();
    ten.dispose();
  });

  it('is one merged buffer, not one per glyph', () => {
    const geometry = createRingNumeralsGeometry(config);
    expect(geometry).toBeInstanceOf(THREE.BufferGeometry);
    expect(geometry.getAttribute('position').count).toBeGreaterThan(1000);
    geometry.dispose();
  });

  it('shades the relief smoothly instead of facet by facet', () => {
    // The reported bug: normals came from `computeVertexNormals` over
    // non-indexed geometry, which writes each triangle's face normal to all
    // three of its corners. Every triangle was therefore flat-shaded, and the
    // bend onto the drum plus the sag subdivision gave the numerals plenty of
    // triangles to show. Measure it directly: on a faceted geometry *every*
    // triangle has three identical normals.
    const geometry = createRingNumeralsGeometry(config);
    const normal = geometry.getAttribute('normal');
    expect(normal).toBeTruthy();

    let flat = 0;
    let total = 0;
    for (let i = 0; i < normal.count; i += 3) {
      total += 1;
      const same = [1, 2].every(
        (offset) =>
          normal.getX(i) === normal.getX(i + offset) &&
          normal.getY(i) === normal.getY(i + offset) &&
          normal.getZ(i) === normal.getZ(i + offset),
      );
      if (same) flat += 1;
    }

    // Flat triangles remain — the extrusion has genuinely planar regions and
    // sharp corners — but they must no longer be the whole geometry. Before the
    // fix every triangle was flat (fraction 1.0); after it the fraction is 0.27%
    // (5 of 1878 triangles on this config), the residue of genuinely planar facets.
    // The bound is set at 5% — roughly 18x that observation, so a handful of
    // extra planar triangles from a benign glyph tweak stays green, while any
    // shading regression drives the fraction back toward 1.0 and fails it by a
    // wide margin. A loose bound like 0.6 would let a half-regressed mesh pass.
    expect(total).toBeGreaterThan(100);
    expect(flat / total).toBeLessThan(0.05);
    geometry.dispose();
  });

  it('keeps the relief edge sharp while smoothing the curves', () => {
    // Over-smoothing would round the edge where a numeral's face meets its
    // extruded side, which is its own defect rather than a fix. That edge is a
    // 90 degree crease, so somewhere in the geometry two corners must sit at
    // the same position carrying near-perpendicular normals.
    const geometry = createRingNumeralsGeometry(config, { digits: [0] });
    const position = geometry.getAttribute('position');
    const normal = geometry.getAttribute('normal');

    const seen = new Map<string, [number, number, number][]>();
    let sharpest = 1;
    for (let i = 0; i < position.count; i += 1) {
      const key = [position.getX(i), position.getY(i), position.getZ(i)]
        .map((v) => Math.round(v / 1e-6))
        .join(',');
      const n: [number, number, number] = [normal.getX(i), normal.getY(i), normal.getZ(i)];
      const bucket = seen.get(key);
      if (!bucket) {
        seen.set(key, [n]);
        continue;
      }
      for (const other of bucket) {
        sharpest = Math.min(sharpest, n[0] * other[0] + n[1] * other[1] + n[2] * other[2]);
      }
      bucket.push(n);
    }

    // cos(90 degrees) is 0; allow a little slack for the bend and float32.
    expect(sharpest).toBeLessThan(0.1);
    geometry.dispose();
  });

  it('refuses a configuration whose numerals would not fit', () => {
    const impossible: RingConfig = { ...config, thickness: 8 };
    expect(() => createRingNumeralsGeometry(impossible, { heightFraction: 1.5 })).toThrow(
      /overlap/,
    );
    expect(() => createRingNumeralsGeometry(config, { digits: [] })).toThrow(/empty digit set/);
  });

  it('builds numerals for any ring axis', () => {
    for (const axis of ['x', 'y', 'z'] as const) {
      const geometry = createRingNumeralsGeometry({ ...config, axis });
      expectFinite(geometry);
      geometry.dispose();
    }
  });
});

describe('createSeparatorGlyphGeometry', () => {
  const config = copperPadlockScene.rings;

  it('engraves the colon on the reading line', () => {
    const geometry = createSeparatorGlyphGeometry(config, 'colon');
    const reading = readingAngleForAxis(config.axis);
    const [uAxis, vAxis] = ringPlaneAxes(config.axis);

    // A separator never rotates, so its one glyph must sit on the reading line
    // — the extreme angles straddle it, exactly as the reading digit does. Only
    // this state assertion, not the screenshot, pins the engraving angle.
    const angles = positions(geometry).map((p) => Math.atan2(p[vAxis], p[uAxis]));
    expect(Math.min(...angles)).toBeLessThan(reading);
    expect(Math.max(...angles)).toBeGreaterThan(reading);
    geometry.dispose();
  });

  it('stands on the drum surface like the numerals, and shades cleanly', () => {
    const geometry = createSeparatorGlyphGeometry(config, 'colon');
    expectFinite(geometry);

    for (const point of positions(geometry)) {
      const radius = Math.hypot(point.y, point.z);
      // Sunk slightly into the drum at the base, proud at the face — the same
      // relief the numerals get, so it reads as the same kind of mark.
      expect(radius).toBeGreaterThan(config.radius * 0.95);
      expect(radius).toBeLessThan(config.radius * 1.05);
      expect(Math.abs(point.x)).toBeLessThan(config.thickness / 2);
    }
    geometry.dispose();
  });

  it('rejects a separator glyph it cannot draw', () => {
    expect(() =>
      createSeparatorGlyphGeometry(config, 'slash' as unknown as SeparatorGlyph),
    ).toThrow(/unsupported separator glyph/);
  });
});

describe('createHousingParts', () => {
  it('binds the frame and bezel slots the scenes already declare', () => {
    const parts = createHousingParts({ innerRadius: 2.5, depth: 2.2 });
    const slots = new Set(parts.map((part) => part.slot));

    expect(slots).toContain('housing');
    expect(slots).toContain('bezel');
    expect(slots).toContain('frame');
    for (const slot of slots) expect(MATERIAL_SLOTS).toContain(slot);
    for (const part of parts) {
      expectFinite(part.geometry);
      part.geometry.dispose();
    }
  });

  it('instances the screw studs rather than emitting one mesh each', () => {
    const parts = createHousingParts({ innerRadius: 2.5, depth: 2.2, studCount: 12 });
    const studs = parts.find((part) => part.name === 'housing:studs')!;

    expect(studs.instances).toHaveLength(12);
    for (const part of parts) part.geometry.dispose();
  });

  it('can leave the studs and shackle out entirely', () => {
    const parts = createHousingParts({
      innerRadius: 2.5,
      depth: 2.2,
      studCount: 0,
      includeShackle: false,
    });
    expect(parts.find((part) => part.name === 'housing:studs')).toBeUndefined();
    expect(parts.find((part) => part.name === 'housing:shackle')).toBeUndefined();
    for (const part of parts) part.geometry.dispose();
  });

  it('swings the lid clear of the case mouth', () => {
    const shut = createHousingParts({ innerRadius: 2.5, depth: 2.2, lidOpenAngle: 0 });
    const open = createHousingParts({ innerRadius: 2.5, depth: 2.2 });

    const centreOf = (parts: ReturnType<typeof createHousingParts>): THREE.Vector3 => {
      const lid = parts.find((part) => part.name === 'housing:lid')!.geometry;
      lid.computeBoundingBox();
      return lid.boundingBox!.getCenter(new THREE.Vector3());
    };

    expect(centreOf(shut).x).toBeCloseTo(0, 3);
    // Open, the lid has swung to the hinge side and out of the mouth.
    expect(centreOf(open).x).toBeLessThan(-1);

    for (const part of [...shut, ...open]) part.geometry.dispose();
  });

  it('grows with the interior it has to enclose', () => {
    const small = createHousingParts({ innerRadius: 1, depth: 1 });
    const large = createHousingParts({ innerRadius: 4, depth: 2 });
    const radiusOf = (parts: ReturnType<typeof createHousingParts>): number => {
      const shell = parts.find((part) => part.name === 'housing:case')!.geometry;
      shell.computeBoundingSphere();
      return shell.boundingSphere!.radius;
    };
    expect(radiusOf(large)).toBeGreaterThan(radiusOf(small) * 3);
    for (const part of [...small, ...large]) part.geometry.dispose();
  });
});

describe('validateHousingParams', () => {
  it('accepts a sane case', () => {
    expect(validateHousingParams({ innerRadius: 2, depth: 2 })).toEqual([]);
  });

  it('rejects degenerate cases and reports them all', () => {
    expect(validateHousingParams({ innerRadius: 0, depth: -1 })).toHaveLength(2);
    expect(
      validateHousingParams({ innerRadius: 2, depth: 0.1, wallThickness: 0.5 }),
    ).toContainEqual(expect.stringContaining('too thick'));
  });

  it('throws when built with parameters it rejected', () => {
    expect(() => createHousingParts({ innerRadius: -1, depth: 1 })).toThrow(/innerRadius/);
  });
});
