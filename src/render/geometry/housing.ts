/**
 * Stylised padlock/pocket-watch case generator.
 *
 * Deliberately an approximation of `docs/reference/preset-1-copper-padlock.png`
 * rather than a match: a circular case with a screw-studded bezel, a hinged lid
 * swung open to the left, and a shackle over the top. Fully procedural, which
 * is the decision recorded in `docs/assets.md` — an authored glTF can replace
 * any of these parts later without touching materials, because the parts are
 * already keyed by material slot.
 *
 * Case-local space: the case opening faces +Z, the hinge is on the -X side, the
 * shackle rises along +Y. Everything is centred on the origin.
 */

import * as THREE from 'three';
import { mergeAndDispose } from './extrude.js';
import { boxProjectUv, latheUvToSurface } from './uv.js';
import type { MaterialSlot } from '../../scene/types.js';

export interface HousingParams {
  /** Clear radius the case must enclose — the ring stack plus breathing room. */
  readonly innerRadius: number;
  /** Interior depth along the case axis. */
  readonly depth: number;
  readonly wallThickness?: number;
  /** Radial width of the bezel ring at the mouth of the case. */
  readonly bezelWidth?: number;
  readonly studCount?: number;
  /** How far open the lid is swung, in radians. 0 is shut. */
  readonly lidOpenAngle?: number;
  readonly includeShackle?: boolean;
  readonly radialSegments?: number;
}

/**
 * One renderable piece of the case.
 *
 * `instances` is set for pieces that repeat (the bezel studs); the caller draws
 * those as a single `InstancedMesh` and must dispose it, since an InstancedMesh
 * owns an instance-matrix buffer beyond its geometry.
 */
export interface HousingPart {
  readonly name: string;
  readonly slot: MaterialSlot;
  readonly geometry: THREE.BufferGeometry;
  readonly instances?: readonly THREE.Matrix4[];
}

const DEFAULTS = {
  wallThicknessFraction: 0.09,
  bezelWidthFraction: 0.11,
  studCount: 10,
  lidOpenAngle: (Math.PI * 2) / 3,
  radialSegments: 48,
};

/**
 * Builds the case.
 *
 * Every geometry returned is already positioned in case-local space, so the
 * caller adds meshes at the identity transform and the assembly cannot drift.
 */
export function createHousingParts(params: HousingParams): HousingPart[] {
  const errors = validateHousingParams(params);
  if (errors.length > 0) {
    throw new Error(`Invalid housing parameters:\n  - ${errors.join('\n  - ')}`);
  }

  const segments = Math.max(12, params.radialSegments ?? DEFAULTS.radialSegments);
  const wall = params.wallThickness ?? params.innerRadius * DEFAULTS.wallThicknessFraction;
  const bezelWidth = params.bezelWidth ?? params.innerRadius * DEFAULTS.bezelWidthFraction;
  const outerRadius = params.innerRadius + wall;
  const bezelOuter = outerRadius + bezelWidth;
  const halfDepth = params.depth / 2;
  const studCount = Math.max(0, Math.round(params.studCount ?? DEFAULTS.studCount));
  const lidAngle = params.lidOpenAngle ?? DEFAULTS.lidOpenAngle;

  const parts: HousingPart[] = [];

  parts.push({
    name: 'housing:case',
    slot: 'housing',
    geometry: caseShell(params.innerRadius, outerRadius, wall, halfDepth, segments),
  });

  parts.push({
    name: 'housing:bezel',
    slot: 'bezel',
    geometry: bezelRing(outerRadius, bezelOuter, halfDepth, segments),
  });

  if (studCount > 0) {
    const studRadius = Math.min(bezelWidth * 0.34, params.innerRadius * 0.045);
    parts.push({
      name: 'housing:studs',
      slot: 'bezel',
      geometry: screwStud(studRadius, studRadius * 1.1),
      instances: studPlacements(studCount, (outerRadius + bezelOuter) / 2, halfDepth + studRadius),
    });
  }

  parts.push({
    name: 'housing:lid',
    slot: 'frame',
    geometry: lid(bezelOuter, wall * 1.6, halfDepth, lidAngle, segments),
  });

  parts.push({
    name: 'housing:hinge',
    slot: 'frame',
    geometry: hinge(bezelOuter, halfDepth, wall),
  });

  if (params.includeShackle ?? true) {
    parts.push({
      name: 'housing:shackle',
      slot: 'frame',
      geometry: shackle(outerRadius, wall, halfDepth),
    });
  }

  return parts;
}

/** Case body: an open-fronted shell, revolved from a closed cross-section. */
function caseShell(
  innerRadius: number,
  outerRadius: number,
  wall: number,
  halfDepth: number,
  segments: number,
): THREE.BufferGeometry {
  const back = -halfDepth;
  const front = halfDepth;
  const profile = [
    new THREE.Vector2(0, back),
    new THREE.Vector2(outerRadius, back),
    new THREE.Vector2(outerRadius, front),
    new THREE.Vector2(innerRadius, front),
    new THREE.Vector2(innerRadius, back + wall),
    new THREE.Vector2(0, back + wall),
    new THREE.Vector2(0, back),
  ];
  const geometry = new THREE.LatheGeometry(profile, segments);
  latheUvToSurface(geometry, profile);
  geometry.rotateX(Math.PI / 2);
  geometry.name = 'housing:case';
  return geometry;
}

/** The raised rim around the mouth of the case. */
function bezelRing(
  innerRadius: number,
  outerRadius: number,
  halfDepth: number,
  segments: number,
): THREE.BufferGeometry {
  const lip = (outerRadius - innerRadius) * 0.55;
  const profile = [
    new THREE.Vector2(innerRadius, halfDepth - lip),
    new THREE.Vector2(outerRadius, halfDepth - lip * 1.4),
    new THREE.Vector2(outerRadius, halfDepth),
    new THREE.Vector2(innerRadius, halfDepth + lip * 0.4),
    new THREE.Vector2(innerRadius, halfDepth - lip),
  ];
  const geometry = new THREE.LatheGeometry(profile, segments);
  latheUvToSurface(geometry, profile);
  geometry.rotateX(Math.PI / 2);
  geometry.name = 'housing:bezel';
  return geometry;
}

/** A slotted screw head: a shallow cylinder with a chiselled groove across it. */
function screwStud(radius: number, height: number): THREE.BufferGeometry {
  const head = new THREE.CylinderGeometry(radius, radius * 0.92, height, 12);
  head.rotateX(Math.PI / 2);
  const slot = new THREE.BoxGeometry(radius * 1.9, radius * 0.34, height * 0.4);
  slot.translate(0, 0, height * 0.42);
  const merged = mergeAndDispose([head, slot]);
  boxProjectUv(merged);
  merged.name = 'housing:stud';
  return merged;
}

function studPlacements(count: number, radius: number, z: number): THREE.Matrix4[] {
  const matrices: THREE.Matrix4[] = [];
  const position = new THREE.Vector3();
  const quaternion = new THREE.Quaternion();
  const scale = new THREE.Vector3(1, 1, 1);
  const forward = new THREE.Vector3(0, 0, 1);
  for (let i = 0; i < count; i += 1) {
    const angle = (i / count) * Math.PI * 2 + Math.PI / count;
    position.set(Math.cos(angle) * radius, Math.sin(angle) * radius, z);
    // Rotate each screw slot to a different clock angle, as hand-driven screws
    // always end up.
    quaternion.setFromAxisAngle(forward, angle * 2.7);
    matrices.push(new THREE.Matrix4().compose(position, quaternion, scale));
  }
  return matrices;
}

/** The hinged lid, already swung open about the hinge axis on the -X side. */
function lid(
  radius: number,
  thickness: number,
  halfDepth: number,
  openAngle: number,
  segments: number,
): THREE.BufferGeometry {
  const dish = radius * 0.12;
  const profile = [
    new THREE.Vector2(0, 0),
    new THREE.Vector2(radius * 0.94, 0),
    new THREE.Vector2(radius, thickness * 0.5),
    new THREE.Vector2(radius * 0.9, thickness),
    new THREE.Vector2(radius * 0.5, thickness + dish * 0.35),
    new THREE.Vector2(0, thickness + dish * 0.45),
    new THREE.Vector2(0, 0),
  ];
  const geometry = new THREE.LatheGeometry(profile, segments);
  latheUvToSurface(geometry, profile);
  geometry.rotateX(-Math.PI / 2);

  // Hinge at the case rim on -X: move the lid so its edge sits on the hinge,
  // swing it open about +Y, then move it back out to the rim.
  const hingeX = -radius;
  geometry.translate(-hingeX, 0, -halfDepth);
  geometry.rotateY(-openAngle);
  geometry.translate(hingeX, 0, halfDepth);
  geometry.name = 'housing:lid';
  return geometry;
}

/** Two knuckles and a pin, on the -X side of the rim. */
function hinge(radius: number, halfDepth: number, wall: number): THREE.BufferGeometry {
  const knuckleRadius = wall * 0.9;
  const parts: THREE.BufferGeometry[] = [];
  const pin = new THREE.CylinderGeometry(knuckleRadius * 0.35, knuckleRadius * 0.35, wall * 6, 10);
  parts.push(pin);
  for (const offset of [-wall * 1.8, 0, wall * 1.8]) {
    const knuckle = new THREE.CylinderGeometry(knuckleRadius, knuckleRadius, wall * 1.4, 12);
    knuckle.translate(0, offset, 0);
    parts.push(knuckle);
  }
  const merged = mergeAndDispose(parts);
  merged.translate(-radius, 0, halfDepth * 0.2);
  boxProjectUv(merged);
  merged.name = 'housing:hinge';
  return merged;
}

/**
 * The padlock shackle: a half torus on two straight legs.
 *
 * The legs stop at the top of the case wall and the whole bow sits behind the
 * mid-plane, so it reads as bolted into the case back rather than hanging
 * inside the open mouth.
 */
function shackle(caseRadius: number, wall: number, halfDepth: number): THREE.BufferGeometry {
  const barRadius = wall * 1.1;
  const bendRadius = caseRadius * 0.32;
  const legLength = caseRadius * 0.2;
  // Sunk a little into the case wall so no end cap is ever visible.
  const legBottom = caseRadius * 0.88;
  const bowCentre = legBottom + legLength;

  const bow = new THREE.TorusGeometry(bendRadius, barRadius, 10, 28, Math.PI);
  bow.translate(0, bowCentre, 0);

  const parts: THREE.BufferGeometry[] = [bow];
  for (const side of [-1, 1]) {
    const leg = new THREE.CylinderGeometry(barRadius, barRadius, legLength, 10);
    leg.translate(side * bendRadius, bowCentre - legLength / 2, 0);
    parts.push(leg);
  }

  const merged = mergeAndDispose(parts);
  merged.translate(0, 0, -halfDepth * 0.45);
  boxProjectUv(merged);
  merged.name = 'housing:shackle';
  return merged;
}

/** Parameter checks, reported all at once like the scene validator's. */
export function validateHousingParams(params: HousingParams): string[] {
  const errors: string[] = [];
  if (!(params.innerRadius > 0)) {
    errors.push(`housing innerRadius must be > 0, got ${params.innerRadius}`);
  }
  if (!(params.depth > 0)) errors.push(`housing depth must be > 0, got ${params.depth}`);
  if (params.wallThickness !== undefined && params.wallThickness <= 0) {
    errors.push('housing wallThickness must be > 0');
  }
  if (params.bezelWidth !== undefined && params.bezelWidth <= 0) {
    errors.push('housing bezelWidth must be > 0');
  }
  if (params.studCount !== undefined && params.studCount < 0) {
    errors.push('housing studCount must be >= 0');
  }
  if (errors.length > 0) return errors;

  const wall = params.wallThickness ?? params.innerRadius * DEFAULTS.wallThicknessFraction;
  if (wall >= params.depth / 2) {
    errors.push(
      `housing wall (${wall}) is too thick for a ${params.depth} m deep case; ` +
        'the back plate would swallow the interior',
    );
  }
  return errors;
}
