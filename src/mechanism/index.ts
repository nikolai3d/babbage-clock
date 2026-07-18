/**
 * The mechanism module's public surface.
 *
 * Pure state machine plus easing curves: which ring turns, to what angle, when,
 * and how. No three.js, no DOM, no clock of its own. See `docs/mechanism.md`.
 */

export {
  Mechanism,
  shortestAngle,
  type CountDirection,
  type MechanismEvent,
  type MechanismEventKind,
  type MechanismInput,
  type MechanismListener,
  type MechanismOptions,
  type MechanismSample,
  type RingMotion,
} from './mechanism.js';

export { countdownFrame, clockFrame } from './frames.js';

export {
  clamp01,
  easeInOutCubic,
  escapementEase,
  pulseEnvelope,
  DEFAULT_OVERSHOOT,
  ESCAPEMENT_RELEASE_FRACTION,
} from './easing.js';
