/**
 * Aspect-aware camera framing.
 *
 * A `CameraConfig` is authored by looking at the scene on a desktop, which is a
 * 16:9 frame. A portrait phone is not: the vertical field of view is the same,
 * but the horizontal one collapses with the aspect ratio, so a pose that
 * comfortably contains the mechanism at 16:9 crops the ends off the ring stack
 * at 9:19.5 — and the ring stack *is* the readout. This module re-derives the
 * distance for whatever aspect the viewport turns out to be.
 *
 * The rule, in one sentence: **honour the authored pose, but never let the digit
 * rings leave the frame, and never pull back further than showing them
 * requires.**
 *
 * Three properties follow, and each one is a test:
 *
 * 1. At the reference aspect the authored pose is reproduced exactly, so a
 *    scene looks on a desktop precisely as its author framed it.
 * 2. At any aspect wide enough to contain the whole mechanism, nothing moves —
 *    the authored distance already contains it.
 * 3. At any narrower aspect the camera pulls back only as far as the ring stack
 *    needs, letting the housing crop rather than shrinking the numerals to fit
 *    scenery around them.
 *
 * This is derived from scene data — `CameraConfig` plus a measured content
 * radius — so a new scene inherits the behaviour without knowing this module
 * exists. Nothing here imports three.js.
 */

import { ringStackSpan } from '../geometry/ringLayout.js';
import type { CameraConfig, RingConfig, Vec3 } from './types.js';

/**
 * The aspect a `CameraConfig` is assumed to have been authored at.
 *
 * 16:9 is what the reference renders, the screenshot baselines and every
 * desktop viewport in practice use. Calibrating against it is what makes
 * property 1 above hold by construction rather than by luck.
 */
export const REFERENCE_ASPECT = 16 / 9;

/**
 * Clearance kept around the ring stack when the aspect forces a crop.
 *
 * Rings that exactly touch both edges read as broken rather than as full-bleed,
 * and leave nothing for a scene whose rings grow slightly. 8% is about half a
 * ring width on the seven-ring scene.
 */
const RING_CLEARANCE = 1.08;

/**
 * Radial allowance for what sits proud of a ring's outer surface — the index
 * marks and the bearing studs that ride above the drums.
 */
const RING_RADIAL_ALLOWANCE = 1.2;

/** What has to fit in frame, as radii about the camera target. */
export interface ContentExtent {
  /** Contains everything the scene draws: case, lid, shackle, gear train. */
  readonly contentRadius: number;
  /** Contains the digit rings alone — the part that must never be cropped. */
  readonly ringRadius: number;
}

export interface FramingRequest {
  readonly camera: CameraConfig;
  /** Viewport width / height. */
  readonly aspect: number;
  readonly extent: ContentExtent;
}

export interface Framing {
  /** Where to put the camera. Direction is the authored one; only distance moves. */
  readonly position: Vec3;
  readonly distance: number;
  /** Orbit limits widened, if needed, so the automatic pose is reachable by hand. */
  readonly minDistance: number;
  readonly maxDistance: number;
  /**
   * `whole` when the entire mechanism is in frame, `rings` when the housing is
   * being cropped to keep the numerals large. Surfaced for diagnostics and
   * asserted by the mobile e2e project.
   */
  readonly fit: 'whole' | 'rings';
}

/**
 * The radius of a sphere about the ring stack's centre containing every drum.
 *
 * Pure `RingConfig` maths, so it is known before a single vertex is built and a
 * scene that changes its ring count reframes itself.
 */
export function ringStackRadius(rings: RingConfig): number {
  const halfSpan = ringStackSpan(rings) / 2;
  const radial = rings.radius * RING_RADIAL_ALLOWANCE;
  return Math.hypot(halfSpan, radial);
}

/** Distance from the camera target to the authored eye position. */
export function authoredDistance(camera: CameraConfig): number {
  return Math.hypot(
    camera.position[0] - camera.target[0],
    camera.position[1] - camera.target[1],
    camera.position[2] - camera.target[2],
  );
}

/**
 * The half-angle that binds at this aspect.
 *
 * `fov` is vertical, so the horizontal half-angle is `atan(tan(fovV/2) *
 * aspect)`. Below an aspect of 1 the horizontal one is the smaller — that is
 * exactly the portrait problem, expressed in one line.
 */
function bindingHalfAngle(fovDegrees: number, aspect: number): number {
  const halfVertical = (fovDegrees * Math.PI) / 360;
  return Math.min(halfVertical, Math.atan(Math.tan(halfVertical) * aspect));
}

/** The distance at which a sphere of `radius` exactly fills the frame. */
function fitDistance(radius: number, fovDegrees: number, aspect: number): number {
  return radius / Math.sin(bindingHalfAngle(fovDegrees, aspect));
}

/**
 * Re-derives the camera pose for an aspect ratio.
 *
 * Only the distance along the authored view direction changes. The direction
 * itself is the author's composition — which side the mechanism is lit from,
 * how far above the axis the eye sits — and there is no aspect-driven reason to
 * touch it.
 */
export function frameForAspect({ camera, aspect, extent }: FramingRequest): Framing {
  const authored = authoredDistance(camera);
  const safeAspect = Number.isFinite(aspect) && aspect > 0 ? aspect : REFERENCE_ASPECT;

  // How tightly the author framed their content, as a multiple of the exact
  // fit. Reading it off the authored pose rather than fixing a constant is what
  // lets a scene deliberately sit loose or close and keep that intent at every
  // aspect ratio.
  const referenceFit = fitDistance(extent.contentRadius, camera.fov, REFERENCE_ASPECT);
  const tightness = referenceFit > 0 ? authored / referenceFit : 1;

  const wholeFit = tightness * fitDistance(extent.contentRadius, camera.fov, safeAspect);
  const ringFit =
    tightness * fitDistance(extent.ringRadius * RING_CLEARANCE, camera.fov, safeAspect);

  // The ceiling is the point of the module. Fitting the whole mechanism into a
  // narrow frame would push the camera back until the numerals were a few
  // pixels tall; the rings are the readout, so they set the limit and the case
  // is allowed to run off the edges.
  const ceiling = Math.max(authored, ringFit);
  const distance = Math.max(Math.min(wholeFit, ceiling), Number.EPSILON);

  const direction = normalize([
    camera.position[0] - camera.target[0],
    camera.position[1] - camera.target[1],
    camera.position[2] - camera.target[2],
  ]);

  // Reproduce the authored numbers byte-for-byte when nothing needs to move,
  // rather than re-deriving a position that differs in the last bit.
  const unchanged = Math.abs(distance - authored) <= authored * 1e-9;

  return {
    position: unchanged
      ? camera.position
      : [
          camera.target[0] + direction[0] * distance,
          camera.target[1] + direction[1] * distance,
          camera.target[2] + direction[2] * distance,
        ],
    distance,
    // The viewer must be able to pinch back to whatever the app chose, and to
    // pinch in at least as close as the scene allows.
    minDistance: Math.min(camera.minDistance, distance),
    maxDistance: Math.max(camera.maxDistance, distance),
    fit: wholeFit <= ceiling ? 'whole' : 'rings',
  };
}

function normalize(vector: readonly [number, number, number]): [number, number, number] {
  const length = Math.hypot(vector[0], vector[1], vector[2]);
  if (length === 0) return [0, 0, 1];
  return [vector[0] / length, vector[1] / length, vector[2] / length];
}
