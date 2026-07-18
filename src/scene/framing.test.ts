import { describe, expect, it } from 'vitest';
import { REFERENCE_ASPECT, authoredDistance, frameForAspect, ringStackRadius } from './framing.js';
import { copperPadlockScene } from './scenes/copperPadlock.js';
import type { ContentExtent } from './framing.js';
import type { CameraConfig } from './types.js';

const camera = copperPadlockScene.camera;

/** Roughly what the copper-padlock scene measures at runtime. */
const extent: ContentExtent = {
  contentRadius: 4.3,
  ringRadius: ringStackRadius(copperPadlockScene.rings),
};

/**
 * Half-width of the frame at a distance, in world units — the quantity the
 * whole module exists to keep larger than the ring stack.
 */
function visibleHalfWidth(config: CameraConfig, distance: number, aspect: number): number {
  return distance * Math.tan((config.fov * Math.PI) / 360) * aspect;
}

describe('ringStackRadius', () => {
  it('grows with the ring count', () => {
    const rings = copperPadlockScene.rings;
    expect(ringStackRadius({ ...rings, count: 9 })).toBeGreaterThan(ringStackRadius(rings));
  });

  it('contains the stack it describes', () => {
    // Seven rings at 0.5 spacing span 3.42; the half-span alone is 1.71.
    expect(ringStackRadius(copperPadlockScene.rings)).toBeGreaterThan(1.71);
  });
});

describe('frameForAspect', () => {
  it('reproduces the authored pose at the reference aspect', () => {
    const framing = frameForAspect({ camera, aspect: REFERENCE_ASPECT, extent });

    expect(framing.position).toEqual(camera.position);
    expect(framing.distance).toBeCloseTo(authoredDistance(camera), 10);
    expect(framing.fit).toBe('whole');
  });

  it('leaves a wider-than-reference viewport alone', () => {
    // The vertical field of view binds at every aspect above 1, so there is
    // nothing an ultrawide monitor needs that 16:9 did not already give it.
    const framing = frameForAspect({ camera, aspect: 21 / 9, extent });

    expect(framing.position).toEqual(camera.position);
    expect(framing.fit).toBe('whole');
  });

  it('pulls back on a portrait phone rather than cropping the rings', () => {
    const aspect = 390 / 844;
    const framing = frameForAspect({ camera, aspect, extent });

    expect(framing.distance).toBeGreaterThan(authoredDistance(camera));
    expect(framing.fit).toBe('rings');
    // The claim the acceptance criterion rests on: the whole stack is in frame.
    expect(visibleHalfWidth(camera, framing.distance, aspect)).toBeGreaterThan(extent.ringRadius);
  });

  it('keeps the ring stack in frame at every plausible phone aspect', () => {
    // Down to a split-screen or folded viewport, which is where the fixed
    // authored pose used to cut the ends off the readout.
    for (const aspect of [0.3, 0.35, 0.4, 0.46, 0.5, 0.56, 0.62, 0.75, 1]) {
      const framing = frameForAspect({ camera, aspect, extent });
      expect(visibleHalfWidth(camera, framing.distance, aspect)).toBeGreaterThan(extent.ringRadius);
    }
  });

  it('never pulls back further than the rings require', () => {
    // The failure this guards against is fitting the whole case into a narrow
    // frame, which shrinks the numerals to nothing.
    const aspect = 0.35;
    const framing = frameForAspect({ camera, aspect, extent });
    const wholeMechanismFit = frameForAspect({
      camera,
      aspect,
      extent: { ...extent, ringRadius: extent.contentRadius },
    });

    expect(framing.distance).toBeLessThan(wholeMechanismFit.distance);
  });

  it('widens the orbit limits to contain the pose it chose', () => {
    const framing = frameForAspect({ camera, aspect: 0.3, extent });

    expect(framing.maxDistance).toBeGreaterThanOrEqual(framing.distance);
    expect(framing.minDistance).toBeLessThanOrEqual(framing.distance);
    // A scene's own limits are never tightened, only widened.
    expect(framing.maxDistance).toBeGreaterThanOrEqual(camera.maxDistance);
    expect(framing.minDistance).toBeLessThanOrEqual(camera.minDistance);
  });

  it('keeps the authored view direction', () => {
    const framing = frameForAspect({ camera, aspect: 0.4, extent });
    const authored = [
      camera.position[0] - camera.target[0],
      camera.position[1] - camera.target[1],
      camera.position[2] - camera.target[2],
    ];
    const derived = [
      framing.position[0] - camera.target[0],
      framing.position[1] - camera.target[1],
      framing.position[2] - camera.target[2],
    ];
    const scale = derived[2]! / authored[2]!;

    expect(derived[0]).toBeCloseTo(authored[0]! * scale, 8);
    expect(derived[1]).toBeCloseTo(authored[1]! * scale, 8);
  });

  it('honours how tightly the scene was framed', () => {
    // Two scenes with identical content but different authored distances must
    // stay in the same proportion at any aspect: the module reads intent off
    // the pose instead of imposing a fit of its own.
    // Both sit straight out along +z from the shared target, so their authored
    // distances are exactly 8 and 16.
    const close: CameraConfig = { ...camera, position: [0, camera.target[1], 8] };
    const far: CameraConfig = { ...camera, position: [0, camera.target[1], 16] };
    const aspect = 0.45;

    const closeFraming = frameForAspect({ camera: close, aspect, extent });
    const farFraming = frameForAspect({ camera: far, aspect, extent });

    expect(farFraming.distance / closeFraming.distance).toBeCloseTo(2, 6);
  });

  it('falls back to the reference aspect for a degenerate viewport', () => {
    // A ResizeObserver can report a zero-sized box mid-layout.
    for (const aspect of [0, Number.NaN, Number.POSITIVE_INFINITY, -1]) {
      expect(frameForAspect({ camera, aspect, extent }).distance).toBeCloseTo(
        authoredDistance(camera),
        10,
      );
    }
  });
});
