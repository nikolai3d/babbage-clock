import { describe, expect, it, vi } from 'vitest';
import { countdownFrame, clockFrame } from './frames.js';
import { Mechanism, type MechanismEvent } from './mechanism.js';
import { DIGITS_PER_RING, ringAngleForDigit } from '../geometry/ringLayout.js';
import { computeRemaining, MAX_DISPLAY_SECONDS } from '../time/countdown.js';

const STEP = (Math.PI * 2) / DIGITS_PER_RING;
const RINGS = 7;
/** An arbitrary target; only the intervals from it matter. */
const TARGET_MS = Date.UTC(2031, 0, 1, 0, 0, 0);

/**
 * Drives a mechanism the way the renderer does: hand it the clock, never a
 * delta. `at(secondsLeft)` lands half a second into the second so that the
 * flooring in `computeRemaining` is never the thing under test.
 */
class Driver {
  readonly mechanism: Mechanism;
  readonly events: MechanismEvent[] = [];
  nowMs = 0;

  constructor(options: Partial<ConstructorParameters<typeof Mechanism>[0]> = {}) {
    this.mechanism = new Mechanism({ ringCount: RINGS, ...options });
    this.mechanism.subscribe((event) => this.events.push(event));
  }

  /** Feeds the frame `secondsLeft` before the target. */
  at(secondsLeft: number, offsetMs = 0): MechanismEvent | null {
    this.nowMs = TARGET_MS - secondsLeft * 1000 - 500 + offsetMs;
    return this.feed(this.nowMs);
  }

  /** Feeds a frame at an explicit instant, for mid-animation sampling. */
  feed(nowMs: number): MechanismEvent | null {
    this.nowMs = nowMs;
    const remaining = computeRemaining(TARGET_MS, nowMs);
    return this.mechanism.update(countdownFrame(remaining, RINGS), nowMs);
  }

  sample(nowMs = this.nowMs) {
    return this.mechanism.sample(nowMs);
  }
}

function angles(driver: Driver, nowMs?: number): readonly number[] {
  return driver.sample(nowMs).ringAngles;
}

describe('Mechanism — adoption', () => {
  it('adopts the first reading instantly and silently', () => {
    const driver = new Driver();
    const event = driver.at(3661); // 001:01:01

    expect(event).toBeNull();
    expect(driver.events).toHaveLength(0);
    expect(driver.mechanism.digits).toEqual([0, 0, 1, 0, 1, 0, 1]);
    // Already settled: no spin-up animation on page load.
    expect(angles(driver)).toEqual([0, 0, 1, 0, 1, 0, 1].map((d) => ringAngleForDigit(d)));
  });

  it('rejects a digit array that does not match the ring count', () => {
    const mechanism = new Mechanism({ ringCount: 5 });
    expect(() => {
      mechanism.update(
        { digits: [1, 2, 3], sequence: 0, expired: false, direction: 'down' },
        0,
      );
    }).toThrow(/expected 5 digits/);
  });
});

describe('Mechanism — the ordinary tick', () => {
  it('moves only the seconds ring, one step, as a discrete snap', () => {
    const driver = new Driver();
    driver.at(3661);
    const event = driver.at(3660)!;

    expect(event.kind).toBe('tick');
    expect(event.motions).toHaveLength(1);
    expect(event.motions[0]).toMatchObject({ ring: 6, fromDigit: 1, toDigit: 0, steps: 1 });
    expect(event.motions[0]!.deltaAngle).toBeCloseTo(STEP, 12);
    expect(event.carryDepth).toBe(0);
    expect(event.durationMs).toBeGreaterThanOrEqual(150);
    expect(event.durationMs).toBeLessThanOrEqual(300);
  });

  it('holds the other rings dead still while the seconds ring turns', () => {
    const driver = new Driver();
    driver.at(3661);
    const before = [...angles(driver)];
    driver.at(3660);

    for (const fraction of [0.1, 0.35, 0.7, 1.4]) {
      const sample = driver.sample(driver.nowMs + 190 * fraction);
      for (let ring = 0; ring < RINGS - 1; ring += 1) {
        expect(sample.ringAngles[ring]).toBe(before[ring]);
        // Their detents never leave the notch.
        expect(sample.detentAngles[ring]).toBe(0);
      }
    }
  });

  it('overshoots and settles rather than sliding', () => {
    const driver = new Driver();
    driver.at(3661);
    const start = angles(driver)[6]!;
    const event = driver.at(3660)!;
    const end = start + STEP;

    const trace = Array.from(
      { length: 61 },
      (_, i) => angles(driver, event.atMs + (event.durationMs * i) / 60)[6]!,
    );

    expect(trace[0]).toBeCloseTo(start, 12);
    expect(trace[trace.length - 1]).toBeCloseTo(end, 12);
    expect(Math.max(...trace)).toBeGreaterThan(end);
  });

  it('settles exactly on the digit angle and stays there', () => {
    const driver = new Driver();
    driver.at(3661);
    const event = driver.at(3660)!;

    const settled = driver.sample(event.atMs + event.durationMs + 1);
    expect(settled.ringAngles[6]).toBeCloseTo(ringAngleForDigit(0), 12);
    expect(settled.detentAngles[6]).toBe(0);
    expect(settled.digits).toEqual([0, 0, 1, 0, 1, 0, 0]);
  });

  it('lifts the detent of a moving ring and drops it again', () => {
    const driver = new Driver();
    driver.at(3661);
    const event = driver.at(3660)!;

    expect(driver.sample(event.atMs).detentAngles[6]).toBeCloseTo(0, 9);
    expect(driver.sample(event.atMs + event.durationMs / 2).detentAngles[6]).toBeGreaterThan(0.1);
    expect(driver.sample(event.atMs + event.durationMs).detentAngles[6]).toBeCloseTo(0, 9);
  });

  it('rolls a countdown drum forward through 0 -> 9 instead of unwinding it', () => {
    const driver = new Driver();
    driver.at(3660); // ...:00
    const event = driver.at(3659)!; // ...:59, so the seconds units ring underflows

    const units = event.motions.find((motion) => motion.ring === 6)!;
    expect(units).toMatchObject({ fromDigit: 0, toDigit: 9, steps: 1 });
    // One step forward, not nine steps back: the sign is what makes a cryptex
    // drum look like a cryptex drum.
    expect(units.deltaAngle).toBeCloseTo(STEP, 12);
  });
});

describe('Mechanism — carry cascades', () => {
  it('carries at a X0:00 boundary as one coordinated event', () => {
    const driver = new Driver();
    driver.at(600); // 000:10:00
    expect(driver.mechanism.digits).toEqual([0, 0, 0, 1, 0, 0, 0]);

    const event = driver.at(599)!; // 000:09:59
    expect(event.kind).toBe('tick');
    expect(event.digits).toEqual([0, 0, 0, 0, 9, 5, 9]);
    expect(event.motions.map((motion) => motion.ring)).toEqual([3, 4, 5, 6]);
    expect(event.carryDepth).toBe(3);

    // One release of the escapement: every ring starts and finishes together.
    const starts = new Set(event.motions.map(() => event.atMs));
    expect(starts.size).toBe(1);
    expect(event.durationMs).toBeGreaterThan(0);
  });

  it('turns the tens-of-minutes ring five steps in that single event', () => {
    const driver = new Driver();
    driver.at(600);
    const event = driver.at(599)!;

    const tensOfMinutes = event.motions.find((motion) => motion.ring === 5)!;
    expect(tensOfMinutes).toMatchObject({ fromDigit: 0, toDigit: 5, steps: 5 });
    expect(tensOfMinutes.deltaAngle).toBeCloseTo(5 * STEP, 12);
  });

  it('animates 100:00:00 -> 099:59:59 as one event across all seven rings', () => {
    const driver = new Driver();
    driver.at(360_000);
    expect(driver.mechanism.digits).toEqual([1, 0, 0, 0, 0, 0, 0]);

    const event = driver.at(359_999)!;

    expect(event.kind).toBe('tick');
    expect(event.digits).toEqual([0, 9, 9, 5, 9, 5, 9]);
    expect(event.motions).toHaveLength(7);
    expect(event.carryDepth).toBe(6);
    expect(driver.events).toHaveLength(1); // one event, not six staggered ones

    // The property the requirement is about: identical timing for every ring.
    const timings = new Set(
      event.motions.map(() => `${event.atMs}:${event.durationMs}`),
    );
    expect(timings.size).toBe(1);
  });

  it('leaves every carried ring exactly on its digit once the event ends', () => {
    const driver = new Driver();
    driver.at(360_000);
    const event = driver.at(359_999)!;

    const settled = driver.sample(event.atMs + event.durationMs + 1);
    const expected = [0, 9, 9, 5, 9, 5, 9].map((digit) => ringAngleForDigit(digit));
    settled.ringAngles.forEach((angle, i) => expect(angle).toBeCloseTo(expected[i]!, 12));
  });

  it('gives a deeper carry a little longer, but keeps it inside the tick budget', () => {
    const shallow = new Driver();
    shallow.at(3661);
    const shallowEvent = shallow.at(3660)!;

    const deep = new Driver();
    deep.at(360_000);
    const deepEvent = deep.at(359_999)!;

    expect(deepEvent.durationMs).toBeGreaterThan(shallowEvent.durationMs);
    expect(deepEvent.durationMs).toBeLessThanOrEqual(300);
  });

  it('carries every second of a full minute rollover without drift', () => {
    const driver = new Driver();
    driver.at(65);
    for (let secondsLeft = 64; secondsLeft >= 55; secondsLeft -= 1) {
      const event = driver.at(secondsLeft)!;
      expect(event.kind).toBe('tick');
      const settled = driver.sample(driver.nowMs + event.durationMs + 1);
      const remaining = computeRemaining(TARGET_MS, driver.nowMs);
      const expected = [
        0,
        0,
        0,
        Math.floor(remaining.minutes / 10),
        remaining.minutes % 10,
        Math.floor(remaining.seconds / 10),
        remaining.seconds % 10,
      ];
      expect(settled.digits).toEqual(expected);
      settled.ringAngles.forEach((angle, i) =>
        expect(angle).toBeCloseTo(ringAngleForDigit(expected[i]!), 12),
      );
    }
  });
});

describe('Mechanism — expiry', () => {
  it('takes the last tick normally and marks it as the expiry event', () => {
    const driver = new Driver();
    driver.at(1); // 000:00:01
    const event = driver.at(-0.5)!; // target passed

    expect(event.kind).toBe('expire');
    expect(event.expired).toBe(true);
    expect(event.digits).toEqual([0, 0, 0, 0, 0, 0, 0]);
    expect(event.motions).toHaveLength(1);
    expect(event.motions[0]).toMatchObject({ ring: 6, fromDigit: 1, toDigit: 0, steps: 1 });
    expect(driver.mechanism.expired).toBe(true);
  });

  it('winds the train down to a stop instead of halting it', () => {
    const driver = new Driver();
    driver.at(1);
    const event = driver.at(-0.5)!;

    expect(driver.sample(event.atMs).driveFactor).toBeCloseTo(1, 6);
    const mid = driver.sample(event.atMs + 1300);
    expect(mid.driveFactor).toBeGreaterThan(0.3);
    expect(mid.driveFactor).toBeLessThan(0.7);
    expect(mid.running).toBe(true);

    const stopped = driver.sample(event.atMs + 4000);
    expect(stopped.driveFactor).toBe(0);
    expect(stopped.running).toBe(false);
    // The balance comes to rest centred, not frozen mid-swing.
    expect(Math.abs(stopped.escapement)).toBe(0);
  });

  it('coasts: the drive phase keeps advancing during the wind-down, then freezes', () => {
    const driver = new Driver();
    driver.at(1);
    const event = driver.at(-0.5)!;

    const atStop = driver.mechanism.drivePhaseSeconds(event.atMs + 2600);
    expect(atStop).toBeGreaterThan(driver.mechanism.drivePhaseSeconds(event.atMs));
    expect(driver.mechanism.drivePhaseSeconds(event.atMs + 60_000)).toBeCloseTo(atStop, 9);
  });

  it('emits no further events once expired', () => {
    const driver = new Driver();
    driver.at(1);
    driver.at(-0.5);
    const before = driver.events.length;

    for (let i = 1; i < 10; i += 1) driver.at(-i);

    expect(driver.events).toHaveLength(before);
    expect(driver.mechanism.digits).toEqual([0, 0, 0, 0, 0, 0, 0]);
  });

  it('is found already stopped when the page opens after the target', () => {
    const driver = new Driver();
    driver.at(-500);

    expect(driver.mechanism.expired).toBe(true);
    expect(driver.sample().driveFactor).toBe(0);
    expect(driver.sample().running).toBe(false);
    expect(driver.events).toHaveLength(0);
  });

  it('starts running again if the target moves back into the future', () => {
    const mechanism = new Mechanism({ ringCount: RINGS });
    mechanism.update({ digits: zeros(), sequence: 0, expired: true, direction: 'down' }, 1000);
    expect(mechanism.driveFactor(1000)).toBe(0);

    const event = mechanism.update(
      { digits: digitsOf('0000123'), sequence: 5, expired: false, direction: 'down' },
      2000,
    );

    expect(event!.kind).toBe('seek');
    expect(mechanism.expired).toBe(false);
    expect(mechanism.driveFactor(2000)).toBe(1);
    // Phase keeps moving forward again rather than jumping.
    expect(mechanism.drivePhaseSeconds(3000)).toBeGreaterThan(
      mechanism.drivePhaseSeconds(2000),
    );
  });
});

describe('Mechanism — the 999-hour cap', () => {
  it('holds the rings still while the countdown is clamped', () => {
    const driver = new Driver();
    const farOut = MAX_DISPLAY_SECONDS + 5000;
    driver.at(farOut);
    expect(driver.mechanism.digits).toEqual([9, 9, 9, 5, 9, 5, 9]);

    for (let i = 1; i <= 20; i += 1) driver.at(farOut - i);

    expect(driver.events).toHaveLength(0);
  });

  it('resumes with an ordinary tick on the first second under the cap', () => {
    const driver = new Driver();
    driver.at(MAX_DISPLAY_SECONDS + 1);
    // Still pinned at the cap: nothing moves.
    expect(driver.at(MAX_DISPLAY_SECONDS)).toBeNull();

    const next = driver.at(MAX_DISPLAY_SECONDS - 1)!;
    expect(next.kind).toBe('tick');
    expect(next.carryDepth).toBe(0);
    expect(next.digits).toEqual([9, 9, 9, 5, 9, 5, 8]);
  });
});

describe('Mechanism — corrections', () => {
  it('seeks the short way round after a jump, and never spins', () => {
    const driver = new Driver();
    driver.at(3661);
    const event = driver.at(999)!;

    expect(event.kind).toBe('seek');
    for (const motion of event.motions) {
      expect(Math.abs(motion.deltaAngle)).toBeLessThanOrEqual(Math.PI + 1e-9);
    }
  });

  it('lets an in-flight tick finish instead of re-planning it every frame', () => {
    const driver = new Driver();
    driver.at(3661);
    const tick = driver.at(3660)!;

    // Sixty frames inside the same second, as the renderer really calls it.
    for (let i = 1; i <= 60; i += 1) {
      expect(driver.feed(tick.atMs + i * 3)).toBeNull();
    }
    expect(driver.events).toHaveLength(1);
    expect(driver.sample(tick.atMs + tick.durationMs + 1).ringAngles[6]).toBeCloseTo(
      ringAngleForDigit(0),
      12,
    );
  });

  it('re-aims a ring that is still in flight rather than stranding it', () => {
    const mechanism = new Mechanism({ ringCount: RINGS });
    mechanism.update(frame('0000001', 0), 1000);
    const tick = mechanism.update(frame('0000000', 1), 2000)!;
    expect(tick.kind).toBe('tick');

    // Half way through the snap, a re-sync steps the readout to 000:00:47.
    const seek = mechanism.update(frame('0000047', 40), 2000 + tick.durationMs / 2)!;

    expect(seek.kind).toBe('seek');
    expect(seek.motions.some((motion) => motion.ring === 6)).toBe(true);
    for (const motion of seek.motions) {
      expect(Math.abs(motion.deltaAngle)).toBeLessThanOrEqual(Math.PI + 1e-9);
    }

    const settled = mechanism.sample(seek.atMs + seek.durationMs + 1);
    expect(settled.digits).toEqual(digitsOf('0000047'));
    settled.ringAngles.forEach((angle, i) =>
      expect(angle).toBeCloseTo(ringAngleForDigit(digitsOf('0000047')[i]!), 12),
    );
  });

  it('is correct on the first frame after a tab sleeps for an hour', () => {
    const driver = new Driver();
    driver.at(7200);
    const event = driver.at(3600)!;

    expect(event.kind).toBe('seek');
    const settled = driver.sample(event.atMs + event.durationMs + 1);
    expect(settled.digits).toEqual([0, 0, 1, 0, 0, 0, 0]);
  });

  it('derives the drive phase from the clock, so a sleep does not rewind the train', () => {
    const driver = new Driver();
    driver.at(7200);
    const startPhase = driver.mechanism.drivePhaseSeconds(driver.nowMs);
    const later = driver.nowMs + 3_600_000;

    expect(driver.mechanism.drivePhaseSeconds(later) - startPhase).toBeCloseTo(3600, 6);
  });

  it('a clock that steps backwards still resolves to the right digits', () => {
    const driver = new Driver();
    driver.at(3600);
    const event = driver.at(3605)!; // re-sync moved the clock back 5 s

    expect(event.kind).toBe('seek');
    const settled = driver.sample(event.atMs + event.durationMs + 1);
    expect(settled.digits).toEqual([0, 0, 1, 0, 0, 0, 5]);
  });
});

describe('Mechanism — counting up', () => {
  it('turns the drums the other way in clock mode', () => {
    const mechanism = new Mechanism({ ringCount: 6 });
    const base = Date.UTC(2031, 5, 1, 12, 0, 0);
    mechanism.update(clockFrame(base, 6), base);
    const event = mechanism.update(clockFrame(base + 1000, 6), base + 1000)!;

    expect(event.kind).toBe('tick');
    const units = event.motions.find((motion) => motion.ring === 5)!;
    expect(units.steps).toBe(1);
    expect(units.deltaAngle).toBeCloseTo(-STEP, 12);
  });
});

describe('Mechanism — motion disabled (?nomotion=1)', () => {
  it('snaps instantly and freezes every continuously moving part', () => {
    const driver = new Driver({ motion: false });
    driver.at(3661);
    const event = driver.at(3660)!;

    expect(event.durationMs).toBe(0);

    const sample = driver.sample(event.atMs);
    expect(sample.ringAngles[6]).toBeCloseTo(ringAngleForDigit(0), 12);
    expect(sample.detentAngles.every((angle) => angle === 0)).toBe(true);
    expect(sample.tickPulse).toBe(0);
    expect(sample.escapement).toBe(0);
    expect(sample.drivePhaseSeconds).toBe(0);
  });

  it('gives the same picture at any instant, which is what screenshots need', () => {
    const driver = new Driver({ motion: false });
    driver.at(3661);
    driver.at(3660);

    const a = driver.sample(driver.nowMs);
    const b = driver.sample(driver.nowMs + 137);
    expect(b.ringAngles).toEqual(a.ringAngles);
    expect(b.escapement).toBe(a.escapement);
  });
});

describe('Mechanism — the running train', () => {
  it('always has something moving between ticks', () => {
    const driver = new Driver();
    driver.at(3661);

    const a = driver.sample(driver.nowMs);
    const b = driver.sample(driver.nowMs + 100);
    expect(b.drivePhaseSeconds).toBeGreaterThan(a.drivePhaseSeconds);
    expect(b.escapement).not.toBe(a.escapement);
  });

  it('swings the balance across its full travel', () => {
    const driver = new Driver({ balancePeriodSeconds: 0.4 });
    driver.at(3661);
    const swing = Array.from({ length: 41 }, (_, i) =>
      driver.sample(driver.nowMs + i * 10).escapement,
    );

    expect(Math.max(...swing)).toBeGreaterThan(0.9);
    expect(Math.min(...swing)).toBeLessThan(-0.9);
  });

  it('kicks the train on a tick and only on a tick', () => {
    const driver = new Driver();
    driver.at(3661);
    expect(driver.sample().tickPulse).toBe(0);

    const event = driver.at(3660)!;
    expect(driver.sample(event.atMs + event.durationMs / 2).tickPulse).toBeGreaterThan(0.9);
    expect(driver.sample(event.atMs + event.durationMs + 1).tickPulse).toBeCloseTo(0, 9);
  });
});

describe('Mechanism — subscribers', () => {
  it('notifies subscribers with the same events the animation runs on', () => {
    const driver = new Driver();
    const listener = vi.fn();
    const unsubscribe = driver.mechanism.subscribe(listener);

    driver.at(600);
    const event = driver.at(599)!;
    expect(listener).toHaveBeenCalledWith(event);

    unsubscribe();
    driver.at(598);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('reset returns it to the unstarted state', () => {
    const driver = new Driver();
    driver.at(3661);
    driver.at(3660);
    driver.mechanism.reset();

    expect(driver.mechanism.lastMechanismEvent).toBeNull();
    expect(driver.at(3600)).toBeNull();
  });
});

function zeros(): number[] {
  return Array.from({ length: RINGS }, () => 0);
}

function digitsOf(text: string): number[] {
  return [...text].map((char) => Number(char));
}

/** A hand-built countdown frame, for cases the wall clock cannot express. */
function frame(text: string, sequence: number) {
  return { digits: digitsOf(text), sequence, expired: false, direction: 'down' } as const;
}
