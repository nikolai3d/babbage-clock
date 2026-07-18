/**
 * The escapement: balance wheel, escape wheel, balance cock and detent lever.
 *
 * These are the parts that make the mechanism read as a mechanism rather than
 * as a set of spinning discs — something is always moving (the balance), the
 * ticks are visibly released (the escape wheel), and the rings are visibly held
 * between ticks (the detents).
 *
 * Escapement-local space follows the gear convention from `docs/assets.md`:
 * wheels lie in the XZ plane and turn about **+Y**, centred on the origin. The
 * detent lever is the exception and is documented on its own generator.
 */

import * as THREE from 'three';
import { createGearGeometry } from './gear.js';
import { boxProjectUv } from './uv.js';
import { mergeAndDispose } from './extrude.js';
import type { MaterialSlot } from '../../scene/types.js';

export interface EscapementParams {
  /** Balance wheel radius in metres. */
  readonly balanceRadius: number;
  /** Escape wheel radius in metres. */
  readonly escapeRadius: number;
  /** Face width of both wheels. */
  readonly thickness: number;
  readonly escapeTeeth?: number;
  readonly balanceSpokes?: number;
  /** How far the cock reaches past the balance, as a fraction of its radius. */
  readonly cockReach?: number;
}

/**
 * One piece of the escapement.
 *
 * `spins` marks the pieces that turn: the caller puts those on their own group
 * so the static cock does not rotate with the wheel it holds.
 */
export interface EscapementPart {
  readonly name: 'escapement:balance' | 'escapement:escape-wheel' | 'escapement:cock';
  readonly slot: MaterialSlot;
  readonly geometry: THREE.BufferGeometry;
  readonly spins: boolean;
}

const DEFAULTS = {
  escapeTeeth: 15,
  balanceSpokes: 3,
  cockReach: 1.45,
};

export function createEscapementParts(params: EscapementParams): EscapementPart[] {
  const errors = validateEscapementParams(params);
  if (errors.length > 0) {
    throw new Error(`Invalid escapement parameters:\n  - ${errors.join('\n  - ')}`);
  }

  const spokes = Math.max(2, Math.round(params.balanceSpokes ?? DEFAULTS.balanceSpokes));

  return [
    {
      name: 'escapement:balance',
      slot: 'bezel',
      geometry: balanceWheel(params.balanceRadius, params.thickness, spokes),
      spins: true,
    },
    {
      name: 'escapement:escape-wheel',
      slot: 'gearD',
      geometry: escapeWheel(
        params.escapeRadius,
        params.thickness,
        Math.max(6, Math.round(params.escapeTeeth ?? DEFAULTS.escapeTeeth)),
      ),
      spins: true,
    },
    {
      name: 'escapement:cock',
      slot: 'frame',
      geometry: balanceCock(
        params.balanceRadius,
        params.thickness,
        params.cockReach ?? DEFAULTS.cockReach,
      ),
      spins: false,
    },
  ];
}

/**
 * A heavy rim on light spokes — the shape that says "this thing oscillates".
 *
 * Rim, spokes, hub and staff merge into one buffer, so the whole balance is a
 * single draw call.
 */
function balanceWheel(radius: number, thickness: number, spokes: number): THREE.BufferGeometry {
  const tube = Math.min(thickness * 0.55, radius * 0.13);
  const rim = new THREE.TorusGeometry(radius - tube, tube, 8, 36);
  rim.rotateX(Math.PI / 2);

  const parts: THREE.BufferGeometry[] = [rim];

  for (let i = 0; i < spokes; i += 1) {
    const spoke = new THREE.BoxGeometry(2 * (radius - tube), thickness * 0.34, tube * 0.9);
    spoke.rotateY((i * Math.PI) / spokes);
    parts.push(spoke);
  }

  const hub = new THREE.CylinderGeometry(tube * 1.7, tube * 1.7, thickness, 14);
  parts.push(hub);

  // The staff runs through the wheel and turns with it.
  const staff = new THREE.CylinderGeometry(tube * 0.55, tube * 0.55, thickness * 5, 10);
  parts.push(staff);

  const merged = mergeAndDispose(parts);
  boxProjectUv(merged);
  merged.name = 'escapement:balance';
  return merged;
}

/** A small, fast, deeply cut wheel: the thing the escapement lets go of. */
function escapeWheel(radius: number, thickness: number, teeth: number): THREE.BufferGeometry {
  const geometry = createGearGeometry({
    teeth,
    radius,
    thickness,
    spokeStyle: 'crescent',
    addendumFactor: 1.25,
  });
  geometry.name = 'escapement:escape-wheel';
  return geometry;
}

/**
 * The bridge the balance staff runs in: a plate anchored out at the case wall,
 * reaching back over the wheel to a boss at its centre.
 *
 * Static — it is the part that makes the balance look held rather than floating.
 */
function balanceCock(radius: number, thickness: number, reach: number): THREE.BufferGeometry {
  const plateThickness = thickness * 0.5;
  const length = radius * reach;
  const width = radius * 0.42;

  const plate = new THREE.BoxGeometry(length, plateThickness, width);
  plate.translate(length / 2 - radius * 0.1, thickness * 1.15, 0);

  const boss = new THREE.CylinderGeometry(radius * 0.2, radius * 0.24, thickness * 0.9, 16);
  boss.translate(0, thickness * 1.15, 0);

  const foot = new THREE.CylinderGeometry(radius * 0.17, radius * 0.17, thickness * 1.6, 12);
  foot.translate(length - radius * 0.2, thickness * 0.55, 0);

  const merged = mergeAndDispose([plate, boss, foot]);
  boxProjectUv(merged);
  merged.name = 'escapement:cock';
  return merged;
}

/**
 * A detent lever: the pawl that sits in a notch on a digit ring and lifts out
 * of the way while that ring turns.
 *
 * Lever-local space is deliberately *not* the wheel convention: the lever
 * pivots at the origin, hangs down towards the drum along **-Y**, and is thin
 * along **X** (the ring axis). The caller rotates that frame onto whichever
 * axis the rings use and rocks it about the pivot.
 */
export function createDetentLeverGeometry(length: number, width: number): THREE.BufferGeometry {
  const armThickness = length * 0.16;

  const pivot = new THREE.CylinderGeometry(armThickness * 0.75, armThickness * 0.75, width, 10);
  pivot.rotateZ(Math.PI / 2);

  const arm = new THREE.BoxGeometry(width * 0.7, length, armThickness);
  arm.translate(0, -length / 2, 0);

  // The nose that drops into the notch.
  const nose = new THREE.ConeGeometry(armThickness * 0.9, armThickness * 1.8, 8);
  nose.rotateX(Math.PI);
  nose.translate(0, -length - armThickness * 0.5, 0);

  const merged = mergeAndDispose([pivot, arm, nose]);
  boxProjectUv(merged);
  merged.name = 'escapement:detent';
  return merged;
}

export function validateEscapementParams(params: EscapementParams): string[] {
  const errors: string[] = [];
  if (!(params.balanceRadius > 0)) {
    errors.push(`escapement balanceRadius must be > 0, got ${params.balanceRadius}`);
  }
  if (!(params.escapeRadius > 0)) {
    errors.push(`escapement escapeRadius must be > 0, got ${params.escapeRadius}`);
  }
  if (!(params.thickness > 0)) {
    errors.push(`escapement thickness must be > 0, got ${params.thickness}`);
  }
  return errors;
}
