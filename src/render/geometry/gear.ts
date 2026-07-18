/**
 * Gear geometry generator.
 *
 * Returns a bare `BufferGeometry` with no material bound: the caller decides
 * which material slot a wheel belongs to, exactly as the scene data says.
 */

// Only the types are needed here: the geometry itself comes from the extruder.
import type * as THREE from 'three';
import {
  gearOutline,
  type GearBodyParams,
  type GearSpokeStyle,
} from '../../geometry/gearProfile.js';
import { extrudeOutlines } from './extrude.js';

export interface GearGeometryParams extends GearBodyParams {
  /** Face width in metres, measured along the rotation axis. */
  readonly thickness: number;
  /** Edge bevel in metres. Small values catch a highlight on the tooth tips. */
  readonly bevel?: number;
}

/**
 * A spur gear centred on the origin, lying in the XZ plane and spinning about
 * +Y — the same convention `GearSpec.axis` is mapped onto by `ClockSceneView`.
 */
export function createGearGeometry(params: GearGeometryParams): THREE.BufferGeometry {
  if (!(params.thickness > 0)) {
    throw new Error(`createGearGeometry: thickness must be > 0, got ${params.thickness}`);
  }

  const outline = gearOutline(params);
  // Bevelling is clamped: a bevel wider than the spoke web would eat through
  // the arms and self-intersect at the cutout corners.
  const requested = params.bevel ?? params.thickness * 0.12;
  const bevel = Math.min(requested, params.thickness * 0.2, params.radius * 0.02);

  // A bevel grows the extrusion by `bevel` at each end, so the depth has to
  // give that back: the caller asked for a face width, not a face width plus
  // whatever the bevel felt like adding.
  const geometry = extrudeOutlines([outline], {
    depth: params.thickness - 2 * bevel,
    bevel,
    centered: true,
  });

  geometry.rotateX(-Math.PI / 2);
  geometry.computeBoundingSphere();
  geometry.name = `gear:${params.teeth}:${params.spokeStyle ?? 'solid'}`;
  return geometry;
}

/**
 * A stable spoke style for a wheel that has not asked for one.
 *
 * `GearSpec` carries no style field yet, so the mechanism bead can add one
 * without breaking anything; until then this keeps the choice deterministic
 * (the same scene always looks the same) and varied (adjacent wheels differ).
 */
export function defaultSpokeStyleFor(index: number, teeth: number): GearSpokeStyle {
  if (teeth >= 30) return 'solid';
  const styles: GearSpokeStyle[] = ['spoke5', 'crescent', 'spoke6'];
  return styles[index % styles.length]!;
}
