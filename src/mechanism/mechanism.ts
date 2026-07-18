/**
 * The clock mechanism: the state machine behind the moving parts.
 *
 * This module is deliberately three.js-free and DOM-free. Everything about
 * *which ring moves, to what angle, starting when, with what easing* is decided
 * here and unit-tested in plain Node; `src/render/clockScene.ts` only reads the
 * sample and writes transforms. A carry cascade whose correctness could only be
 * checked by looking at pixels would not be checkable at all.
 *
 * Two rules shape the design:
 *
 * - **Time is a parameter, never an accumulator.** Both `update` and `sample`
 *   take the current instant; nothing integrates per-frame deltas. A tab that
 *   sleeps for an hour resumes correct on its first frame, and a clock re-sync
 *   that steps the time resolves through a seek instead of leaving a ring
 *   stranded or spinning.
 * - **A carry is one event.** `100:00:00 -> 099:59:59` turns seven rings, and
 *   all seven share a single start time and a single duration, so it reads as
 *   one release of the escapement rather than seven animations that happen to
 *   overlap. Anything else that wants to react to the mechanism — the audio
 *   bead, in particular — subscribes to the same events the animation uses.
 */

import {
  escapementEase,
  easeInOutCubic,
  pulseEnvelope,
  clamp01,
  DEFAULT_OVERSHOOT,
} from './easing.js';
import { DIGITS_PER_RING, digitStepAngle, ringAngleForDigit } from '../geometry/ringLayout.js';

const TWO_PI = Math.PI * 2;

/** Which way the readout counts, and therefore which way the drums turn. */
export type CountDirection = 'down' | 'up';

export type MechanismEventKind =
  /** One natural step of the clock: the seconds ring, plus any rings it carried into. */
  | 'tick'
  /** The readout jumped — first frame after a re-sync, a target change or a long sleep. */
  | 'seek'
  /** The target arrived. Carries the final tick's motions and starts the wind-down. */
  | 'expire';

/** One ring's part in an event. Every motion in an event shares its timing. */
export interface RingMotion {
  /** Ring index, 0 = most significant. */
  readonly ring: number;
  readonly fromDigit: number;
  readonly toDigit: number;
  /** Whole digit positions travelled. 1 for an ordinary tick, 5 for `0 -> 5`. */
  readonly steps: number;
  /** Signed rotation about the ring axis, in radians. */
  readonly deltaAngle: number;
}

export interface MechanismEvent {
  readonly kind: MechanismEventKind;
  /** The instant the motion starts, on the same clock `update` was given. */
  readonly atMs: number;
  readonly durationMs: number;
  readonly digits: readonly number[];
  readonly previousDigits: readonly number[];
  /** Rings that move, in ring order. All share `atMs` and `durationMs`. */
  readonly motions: readonly RingMotion[];
  /**
   * How many rings the carry reached beyond the least significant one. `0` is
   * an ordinary seconds tick; `6` is `100:00:00 -> 099:59:59`.
   */
  readonly carryDepth: number;
  readonly expired: boolean;
}

/** What one frame of the clock looks like to the mechanism. */
export interface MechanismInput {
  /** Most significant first, one entry per ring. */
  readonly digits: readonly number[];
  /** Integer that advances by exactly 1 per natural tick. */
  readonly sequence: number;
  readonly expired: boolean;
  readonly direction: CountDirection;
}

/** Everything the renderer needs for one frame, sampled at a single instant. */
export interface MechanismSample {
  /** Rotation of each ring about the ring axis, in radians. */
  readonly ringAngles: readonly number[];
  /** How far each detent lever is lifted out of its notch, in radians. */
  readonly detentAngles: readonly number[];
  /** The digits currently being displayed. */
  readonly digits: readonly number[];
  /** Drive-train rotation measured in seconds of running time. Winds down. */
  readonly drivePhaseSeconds: number;
  /** 1 while running, easing to 0 across the wind-down after expiry. */
  readonly driveFactor: number;
  /** Balance-wheel deflection, -1…1. */
  readonly escapement: number;
  /** 0…1 impulse the train takes from the current tick. */
  readonly tickPulse: number;
  /** False once the wind-down has finished. */
  readonly running: boolean;
  readonly expired: boolean;
}

export interface MechanismOptions {
  readonly ringCount: number;
  readonly digitsPerRing?: number;
  /** Duration of a single-step tick. */
  readonly tickDurationMs?: number;
  /** Added per extra step in a multi-step carry, up to `maxTickDurationMs`. */
  readonly stepDurationMs?: number;
  readonly maxTickDurationMs?: number;
  /** Duration of a corrective move after a jump. Smooth, never overshoots. */
  readonly seekDurationMs?: number;
  /** How far a tick swings past its notch, as a fraction of one digit step. */
  readonly overshoot?: number;
  /** How long the train takes to coast to a stop once the target arrives. */
  readonly windDownMs?: number;
  /** Balance-wheel period in seconds. */
  readonly balancePeriodSeconds?: number;
  /** Peak detent lift, in radians. */
  readonly detentLiftRadians?: number;
  /**
   * False freezes every moving part: rings snap, the train stops, the balance
   * is centred. This is what `?nomotion=1` sets, and it is what makes a
   * screenshot of a given instant reproducible.
   */
  readonly motion?: boolean;
}

const DEFAULTS = {
  tickDurationMs: 190,
  stepDurationMs: 26,
  maxTickDurationMs: 300,
  seekDurationMs: 420,
  windDownMs: 2600,
  balancePeriodSeconds: 0.4,
  detentLiftRadians: 0.22,
};

interface RingState {
  digit: number;
  /** Angle held while idle; also the origin of the current motion. */
  angle: number;
  fromAngle: number;
  toAngle: number;
  startMs: number;
  endMs: number;
  overshoot: number;
  /** Escapement snap for a tick, smooth ease for a corrective seek. */
  snap: boolean;
  moving: boolean;
}

export type MechanismListener = (event: MechanismEvent) => void;

/**
 * The mechanism.
 *
 * Feed it a frame with `update` and read it with `sample`. It owns no
 * resources, so there is nothing to dispose.
 */
export class Mechanism {
  readonly ringCount: number;
  readonly digitsPerRing: number;
  readonly stepAngle: number;

  private readonly options: Required<Omit<MechanismOptions, 'ringCount' | 'digitsPerRing'>>;
  private readonly rings: RingState[] = [];
  private readonly listeners = new Set<MechanismListener>();

  private started = false;
  private lastSequence = 0;
  private lastEvent: MechanismEvent | null = null;

  /** Drive-seconds banked before the current segment began. */
  private phaseBaseSeconds = 0;
  private segmentStartMs = 0;
  private expiredAtMs: number | null = null;

  constructor(options: MechanismOptions) {
    if (!Number.isInteger(options.ringCount) || options.ringCount < 1) {
      throw new Error(`Mechanism: ringCount must be a positive integer, got ${options.ringCount}`);
    }
    this.ringCount = options.ringCount;
    this.digitsPerRing = options.digitsPerRing ?? DIGITS_PER_RING;
    this.stepAngle = digitStepAngle(this.digitsPerRing);

    this.options = {
      tickDurationMs: options.tickDurationMs ?? DEFAULTS.tickDurationMs,
      stepDurationMs: options.stepDurationMs ?? DEFAULTS.stepDurationMs,
      maxTickDurationMs: options.maxTickDurationMs ?? DEFAULTS.maxTickDurationMs,
      seekDurationMs: options.seekDurationMs ?? DEFAULTS.seekDurationMs,
      overshoot: options.overshoot ?? DEFAULT_OVERSHOOT,
      windDownMs: options.windDownMs ?? DEFAULTS.windDownMs,
      balancePeriodSeconds: options.balancePeriodSeconds ?? DEFAULTS.balancePeriodSeconds,
      detentLiftRadians: options.detentLiftRadians ?? DEFAULTS.detentLiftRadians,
      motion: options.motion ?? true,
    };

    for (let i = 0; i < this.ringCount; i += 1) {
      this.rings.push({
        digit: 0,
        angle: 0,
        fromAngle: 0,
        toAngle: 0,
        startMs: 0,
        endMs: 0,
        overshoot: this.options.overshoot,
        snap: true,
        moving: false,
      });
    }
  }

  /** The digits the rings are settling on, most significant first. */
  get digits(): readonly number[] {
    return this.rings.map((ring) => ring.digit);
  }

  /** The most recent event, or null if the mechanism has never moved. */
  get lastMechanismEvent(): MechanismEvent | null {
    return this.lastEvent;
  }

  get expired(): boolean {
    return this.expiredAtMs !== null;
  }

  /**
   * Subscribes to tick / seek / expire events.
   *
   * These are exactly the events the animation runs on, which is the point: a
   * sound played from here is in sync with the motion by construction rather
   * than by two modules agreeing about timing separately.
   */
  subscribe(listener: MechanismListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * Feeds one frame of the clock in. Returns the event this frame started, or
   * null when nothing changed — which is the usual case, since a frame is
   * ~16 ms and a tick is a second.
   */
  update(input: MechanismInput, nowMs: number): MechanismEvent | null {
    if (input.digits.length !== this.ringCount) {
      throw new Error(
        `Mechanism.update: expected ${this.ringCount} digits, got ${input.digits.length}`,
      );
    }

    if (!this.started) return this.adopt(input, nowMs);

    // Settle anything that finished before deciding what to do next, so a
    // motion started this frame departs from a known angle.
    this.settle(nowMs);

    const previousDigits = this.digits;
    const newlyExpired = input.expired && this.expiredAtMs === null;
    const resumed = !input.expired && this.expiredAtMs !== null;

    if (resumed) this.resumeDrive(nowMs);

    const natural = input.sequence === this.lastSequence + 1;
    this.lastSequence = input.sequence;

    // Nothing to schedule while the reading is unchanged — which is almost
    // every frame, since a frame is ~16 ms and a tick is a second. Returning
    // here is also what lets an in-flight tick run to completion instead of
    // being re-planned sixty times a second.
    if (!newlyExpired && sameDigits(previousDigits, input.digits)) return null;

    const motions = natural
      ? this.planTick(input, previousDigits)
      : this.planSeek(input, previousDigits, nowMs);

    if (motions.length === 0 && !newlyExpired) return null;

    const durationMs = this.durationFor(natural, motions);
    for (const motion of motions) this.startMotion(motion, nowMs, durationMs, natural);
    for (let i = 0; i < this.ringCount; i += 1) this.rings[i]!.digit = input.digits[i]!;

    if (newlyExpired) this.stopDrive(nowMs);

    const event: MechanismEvent = {
      kind: newlyExpired ? 'expire' : natural ? 'tick' : 'seek',
      atMs: nowMs,
      durationMs,
      digits: [...input.digits],
      previousDigits,
      motions,
      carryDepth: motions.filter((motion) => motion.ring !== this.ringCount - 1).length,
      expired: input.expired,
    };
    this.lastEvent = event;
    for (const listener of [...this.listeners]) listener(event);
    return event;
  }

  /** Everything the renderer needs, at one instant. Allocates two small arrays. */
  sample(nowMs: number): MechanismSample {
    this.settle(nowMs);

    const ringAngles: number[] = [];
    const detentAngles: number[] = [];
    const digits: number[] = [];

    for (const ring of this.rings) {
      digits.push(ring.digit);
      if (!ring.moving) {
        ringAngles.push(ring.angle);
        detentAngles.push(0);
        continue;
      }
      const t = progress(ring.startMs, ring.endMs, nowMs);
      const eased = ring.snap ? escapementEase(t, ring.overshoot) : easeInOutCubic(t);
      ringAngles.push(ring.fromAngle + (ring.toAngle - ring.fromAngle) * eased);
      detentAngles.push(pulseEnvelope(t) * this.options.detentLiftRadians);
    }

    const drivePhaseSeconds = this.drivePhaseSeconds(nowMs);
    const driveFactor = this.driveFactor(nowMs);

    return {
      ringAngles,
      detentAngles,
      digits,
      drivePhaseSeconds,
      driveFactor,
      escapement: this.options.motion
        ? Math.sin((TWO_PI * drivePhaseSeconds) / this.options.balancePeriodSeconds) * driveFactor
        : 0,
      tickPulse: this.tickPulse(nowMs),
      running: driveFactor > 0,
      expired: this.expiredAtMs !== null,
    };
  }

  /**
   * Drive-train rotation, expressed as seconds of running time since the
   * mechanism started.
   *
   * A function of `nowMs` within each segment rather than a running total, so
   * gears are in the right place on the first frame after a sleeping tab wakes.
   * Across the wind-down it is the analytic integral of a linear ramp, which is
   * what makes the train coast to a stop rather than halt.
   */
  drivePhaseSeconds(nowMs: number): number {
    if (!this.options.motion || !this.started) return 0;
    if (this.expiredAtMs === null) {
      return this.phaseBaseSeconds + Math.max(0, nowMs - this.segmentStartMs) / 1000;
    }
    const u = clamp01((nowMs - this.expiredAtMs) / this.options.windDownMs);
    return this.phaseBaseSeconds + (this.options.windDownMs / 1000) * (u - (u * u) / 2);
  }

  /** 1 while running, ramping to 0 across the wind-down. */
  driveFactor(nowMs: number): number {
    if (!this.options.motion || !this.started) return 0;
    if (this.expiredAtMs === null) return 1;
    return 1 - clamp01((nowMs - this.expiredAtMs) / this.options.windDownMs);
  }

  /** Resets to the unstarted state; the next `update` adopts its digits instantly. */
  reset(): void {
    this.started = false;
    this.lastEvent = null;
    this.expiredAtMs = null;
    this.phaseBaseSeconds = 0;
    this.segmentStartMs = 0;
    for (const ring of this.rings) {
      ring.digit = 0;
      ring.angle = 0;
      ring.fromAngle = 0;
      ring.toAngle = 0;
      ring.moving = false;
    }
  }

  /** First frame: take the reading as given, with no animation and no event. */
  private adopt(input: MechanismInput, nowMs: number): null {
    for (let i = 0; i < this.ringCount; i += 1) {
      const ring = this.rings[i]!;
      ring.digit = input.digits[i]!;
      ring.angle = ringAngleForDigit(ring.digit, this.digitsPerRing);
      ring.fromAngle = ring.angle;
      ring.toAngle = ring.angle;
      ring.moving = false;
    }
    this.started = true;
    this.lastSequence = input.sequence;
    this.segmentStartMs = nowMs;
    this.phaseBaseSeconds = 0;
    // A clock that was already over before the page opened is found stopped,
    // not caught in the act of stopping.
    this.expiredAtMs = input.expired ? nowMs - this.options.windDownMs : null;
    return null;
  }

  /**
   * A natural step. Each ring turns the way the readout counts — a countdown
   * drum only ever rolls one way, so `0 -> 9` continues forward into an
   * underflow instead of unwinding backwards.
   */
  private planTick(input: MechanismInput, previousDigits: readonly number[]): RingMotion[] {
    const sign = input.direction === 'down' ? 1 : -1;
    const motions: RingMotion[] = [];

    for (let i = 0; i < this.ringCount; i += 1) {
      const fromDigit = previousDigits[i]!;
      const toDigit = input.digits[i]!;
      if (fromDigit === toDigit) continue;
      const steps =
        input.direction === 'down'
          ? mod(fromDigit - toDigit, this.digitsPerRing)
          : mod(toDigit - fromDigit, this.digitsPerRing);
      motions.push({
        ring: i,
        fromDigit,
        toDigit,
        steps,
        deltaAngle: sign * steps * this.stepAngle,
      });
    }
    return motions;
  }

  /**
   * A correction. The readout jumped, so rings take the short way round from
   * wherever they actually are — including mid-flight — and any ring still
   * moving is re-aimed even if its digit did not change. That is what makes a
   * clock re-sync unable to leave a ring stuck or spinning.
   */
  private planSeek(
    input: MechanismInput,
    previousDigits: readonly number[],
    nowMs: number,
  ): RingMotion[] {
    const motions: RingMotion[] = [];

    for (let i = 0; i < this.ringCount; i += 1) {
      const ring = this.rings[i]!;
      const fromDigit = previousDigits[i]!;
      const toDigit = input.digits[i]!;
      const current = this.angleAt(ring, nowMs);
      const delta = shortestAngle(ringAngleForDigit(toDigit, this.digitsPerRing) - current);
      if (fromDigit === toDigit && !ring.moving && Math.abs(delta) < 1e-9) continue;
      motions.push({
        ring: i,
        fromDigit,
        toDigit,
        steps: mod(fromDigit - toDigit, this.digitsPerRing),
        deltaAngle: delta,
      });
    }
    return motions;
  }

  private durationFor(natural: boolean, motions: readonly RingMotion[]): number {
    if (!this.options.motion) return 0;
    if (!natural) return this.options.seekDurationMs;
    // One duration for the whole event: a cascade is a single release of the
    // escapement, so a five-step ring and a one-step ring start and finish
    // together. Deeper carries get a little longer so the long swing does not
    // have to be a blur.
    const maxSteps = motions.reduce((max, motion) => Math.max(max, motion.steps), 1);
    return Math.min(
      this.options.maxTickDurationMs,
      this.options.tickDurationMs + this.options.stepDurationMs * (maxSteps - 1),
    );
  }

  private startMotion(motion: RingMotion, nowMs: number, durationMs: number, snap: boolean): void {
    const ring = this.rings[motion.ring]!;
    const from = this.angleAt(ring, nowMs);
    ring.fromAngle = from;
    ring.toAngle = from + motion.deltaAngle;
    ring.startMs = nowMs;
    ring.endMs = nowMs + durationMs;
    ring.snap = snap;
    ring.moving = durationMs > 0;
    if (!ring.moving) ring.angle = ring.toAngle;
  }

  private angleAt(ring: RingState, nowMs: number): number {
    if (!ring.moving) return ring.angle;
    const t = progress(ring.startMs, ring.endMs, nowMs);
    const eased = ring.snap ? escapementEase(t, ring.overshoot) : easeInOutCubic(t);
    return ring.fromAngle + (ring.toAngle - ring.fromAngle) * eased;
  }

  /**
   * Retires finished motions and re-normalises the resting angle.
   *
   * An idle ring always holds `ringAngleForDigit(digit)` exactly. Without that
   * wrap, a ring that has ticked for a week would hold an angle in the tens of
   * thousands of radians and lose visible precision.
   */
  private settle(nowMs: number): void {
    for (const ring of this.rings) {
      if (ring.moving) {
        if (nowMs < ring.endMs) continue;
        ring.moving = false;
      }
      const canonical = ringAngleForDigit(ring.digit, this.digitsPerRing);
      if (ring.angle === canonical) continue;
      ring.angle = canonical;
      ring.fromAngle = canonical;
      ring.toAngle = canonical;
    }
  }

  private tickPulse(nowMs: number): number {
    const event = this.lastEvent;
    if (!event || !this.options.motion || event.durationMs <= 0) return 0;
    if (event.kind === 'seek') return 0;
    return pulseEnvelope(progress(event.atMs, event.atMs + event.durationMs, nowMs));
  }

  /** Banks the running segment and starts the wind-down. */
  private stopDrive(nowMs: number): void {
    this.phaseBaseSeconds += Math.max(0, nowMs - this.segmentStartMs) / 1000;
    this.segmentStartMs = nowMs;
    this.expiredAtMs = nowMs;
  }

  /** Banks whatever the wind-down managed and starts running again. */
  private resumeDrive(nowMs: number): void {
    const u = clamp01((nowMs - (this.expiredAtMs ?? nowMs)) / this.options.windDownMs);
    this.phaseBaseSeconds += (this.options.windDownMs / 1000) * (u - (u * u) / 2);
    this.segmentStartMs = nowMs;
    this.expiredAtMs = null;
  }
}

/** Progress through a window, clamped. A zero-length window is already over. */
function progress(startMs: number, endMs: number, nowMs: number): number {
  if (endMs <= startMs) return 1;
  return clamp01((nowMs - startMs) / (endMs - startMs));
}

function sameDigits(a: readonly number[], b: readonly number[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/** Non-negative modulo, so `0 - 9` on a ten-digit ring is one step, not nine back. */
function mod(value: number, modulus: number): number {
  return ((value % modulus) + modulus) % modulus;
}

/** Wraps into [-PI, PI) so a correction takes the short way round. */
export function shortestAngle(radians: number): number {
  return ((((radians + Math.PI) % TWO_PI) + TWO_PI) % TWO_PI) - Math.PI;
}
