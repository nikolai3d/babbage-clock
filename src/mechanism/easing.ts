/**
 * Easing curves for the mechanism.
 *
 * Pure maths over the unit interval — no three.js, no DOM, no clock. The
 * escapement curve is the one that carries the whole look of the piece, so it
 * is specified here and pinned by unit tests rather than being tuned by eye in
 * the renderer.
 */

/** Fraction of a tick spent on the release swing; the rest is the settle. */
export const ESCAPEMENT_RELEASE_FRACTION = 0.62;
/** How far past the target the ring swings, as a fraction of the step. */
export const DEFAULT_OVERSHOOT = 0.14;
/** Damping of the settle wobble. Higher settles harder. */
const SETTLE_DAMPING = 4.2;
/** Three quarter-cycles of wobble: over, back under, home. */
const SETTLE_PHASE = Math.PI * 1.5;

export function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 1;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

/** Symmetric cubic ease. Zero velocity at both ends, monotonic throughout. */
export function easeInOutCubic(t: number): number {
  const x = clamp01(t);
  return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2;
}

/**
 * The escapement release: what makes a tick read as mechanical rather than as
 * a slide.
 *
 * Three things have to be true at once, and all three are asserted in
 * `easing.test.ts`:
 *
 * 1. **It starts from rest.** A detent has to lift before anything turns, so
 *    the first sixth of the tick covers almost no angle. A linear or ease-out
 *    curve leaves at full speed and reads as a slide.
 * 2. **It overshoots.** The wheel arrives with momentum and swings past the
 *    detent notch by `overshoot` of a step.
 * 3. **It settles.** The overshoot is pulled back through a damped wobble that
 *    is exactly zero at t = 1, so the ring ends dead on its digit with no
 *    residual error to accumulate.
 */
export function escapementEase(t: number, overshoot: number = DEFAULT_OVERSHOOT): number {
  const x = clamp01(t);
  const release = ESCAPEMENT_RELEASE_FRACTION;

  if (x <= release) {
    // Ease-in-out over the release swing, taken all the way to the peak.
    return (1 + overshoot) * easeInOutCubic(x / release);
  }

  // Damped settle from the peak back onto the notch. The cosine is chosen so
  // that v = 0 gives the peak and v = 1 gives exactly 1: no snapping at the
  // end of the animation and no leftover offset.
  const v = (x - release) / (1 - release);
  return 1 + overshoot * Math.cos(v * SETTLE_PHASE) * Math.exp(-SETTLE_DAMPING * v);
}

/**
 * A single lift-and-reseat pulse: 0 at both ends, 1 in the middle.
 *
 * Drives the detent levers (which lift out of their notch, let a ring pass and
 * drop back) and the impulse the gear train takes from each tick.
 */
export function pulseEnvelope(t: number): number {
  const x = clamp01(t);
  return Math.sin(Math.PI * x);
}
