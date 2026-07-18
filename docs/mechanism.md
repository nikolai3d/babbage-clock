# The mechanism

`src/mechanism/` decides **which ring moves, to what angle, starting when, and
with what easing**. It is three.js-free and DOM-free: it unit-tests in plain
Node, and `src/render/clockScene.ts` only reads its output and writes
transforms.

That split is deliberate. A carry cascade whose correctness could only be
checked by looking at pixels would not be checkable at all — so the boundary
cases (`X0:00`, `100:00:00 -> 099:59:59`, `000:00:01 -> expiry`) are ordinary
unit tests over digit arrays.

## The two rules

1. **Time is a parameter, never an accumulator.** `update(input, nowMs)` and
   `sample(nowMs)` both take the instant. Nothing integrates a frame delta.
   A tab that slept for an hour is correct on its first frame back, and a clock
   re-sync that steps the time resolves through a seek rather than leaving a
   ring stranded or spinning.
2. **A carry is one event.** `100:00:00 -> 099:59:59` turns seven rings, and all
   seven share a single `atMs` and a single `durationMs`. It reads as one
   release of the escapement rather than as seven animations that happen to
   overlap.

## API

```ts
const mechanism = new Mechanism({ ringCount: 7, motion: true });

// Once per frame, from the renderer:
const event = mechanism.update(countdownFrame(remaining, 7), nowMs);
const sample = mechanism.sample(nowMs);
```

### Input

`MechanismInput` is deliberately not a `RemainingTime`: the state machine is
handed digits and a tick counter, nothing else. The two adapters in `frames.ts`
are the only place the clock's meaning is decided.

| Field       | Meaning                                              |
| ----------- | ---------------------------------------------------- |
| `digits`    | One per ring, most significant first.                |
| `sequence`  | Integer that advances by exactly 1 per natural tick. |
| `expired`   | The target has arrived.                              |
| `direction` | `'down'` for a countdown, `'up'` for a clock.        |

- `countdownFrame(remaining, ringCount)` — digits from `remainingDigits`, so the
  999-hour cap reaches the rings; `sequence` is `-totalSeconds`, which does
  **not** advance while the readout is clamped, so a target 4,000 hours out
  holds still at `999:59:59` instead of grinding through corrections.
- `clockFrame(nowMs, ringCount)` — `HHMMSS`, counting up, `sequence` from the
  epoch so midnight is an ordinary tick.

### Events

`update` returns the event it started (usually `null` — a frame is ~16 ms and a
tick is a second) and notifies every `subscribe` listener with the same object.

```ts
interface MechanismEvent {
  kind: 'tick' | 'seek' | 'expire';
  atMs: number; // start instant, on the clock update was given
  durationMs: number; // shared by every motion in the event
  digits: readonly number[];
  previousDigits: readonly number[];
  motions: readonly RingMotion[]; // { ring, fromDigit, toDigit, steps, deltaAngle }
  carryDepth: number; // rings reached beyond the seconds ring; 0 = plain tick
  expired: boolean;
}
```

| Kind     | When                                                                      |
| -------- | ------------------------------------------------------------------------- |
| `tick`   | `sequence` advanced by exactly 1. Escapement easing, with overshoot.      |
| `seek`   | The readout jumped: a re-sync, a long sleep, a target change. Smooth.     |
| `expire` | The target arrived. Carries the final tick's motions and stops the train. |

**For the audio bead:** subscribe to these rather than running a timer of your
own. `kind` selects the sound, `carryDepth` selects its weight (0 is the light
seconds tick; 6 is the full cascade at `100:00:00`), `motions.length` is how
many rings are actually moving, and `atMs` / `durationMs` are the same numbers
the animation is using — so a sound scheduled against them is in sync by
construction rather than by two modules agreeing separately about timing. A
`seek` should generally be silent: it is a correction, not a tick.

### Sample

```ts
interface MechanismSample {
  ringAngles: readonly number[]; // rotation about the ring axis, radians
  detentAngles: readonly number[]; // lever lift, radians; 0 while seated
  digits: readonly number[];
  drivePhaseSeconds: number; // drive-train rotation, in running seconds
  driveFactor: number; // 1 running, ramping to 0 across the wind-down
  escapement: number; // balance deflection, -1…1
  tickPulse: number; // 0…1 impulse the train takes from a tick
  running: boolean;
  expired: boolean;
}
```

`drivePhaseSeconds` is what the gears rotate on: `angularVelocity * phase`. It is
a function of `nowMs` within each segment rather than a running total, and
across the wind-down it is the analytic integral of a linear ramp — which is why
the train coasts to a stop instead of halting, and why a sleeping tab does not
rewind it.

## The tick

`escapementEase` in `easing.ts` is the curve that makes a tick read as
mechanical rather than as a slide. Three properties, all asserted in
`easing.test.ts`:

1. **It starts from rest.** The first 15% of the tick covers under half of what
   a linear slide would. That pause is the detent lifting.
2. **It overshoots** its digit by `overshoot` (14% of a step by default).
3. **It settles** through a damped wobble that is exactly zero at `t = 1`, so a
   ring ends dead on its digit and ticks cannot accumulate error.

A slide is monotonic. This curve is not, and the test says so.

Timing: 190 ms for a single step, plus 26 ms per extra step of a multi-step
carry, capped at 300 ms. A five-step swing (`0 -> 5` on a tens-of-minutes ring)
therefore takes a little longer than a one-step tick but still lands with the
rest of its cascade.

Corrections use `easeInOutCubic` instead — monotonic, no overshoot — so a
re-sync never looks like a tick that did not happen.

## Expiry

`expire` fires once, on the frame the target passes. The final tick to
`000:00:00` runs as a normal snap; then the train winds down over 2.6 s:
`driveFactor` ramps to 0, the gears coast to a stop and the balance comes to
rest centred rather than frozen mid-swing. A page opened after the target is
found already stopped, with no event and no wind-down to watch.

If the target moves back into the future the mechanism resumes: the drive banks
whatever the wind-down managed and starts running again from there.

## `?nomotion=1`

`motion: false` gives every animation a duration of 0 and freezes the drive
phase, the balance and the detents. The readout is still correct — only the
motion between readings is suppressed — so a screenshot taken at a given instant
is reproducible. `main.ts` reads it from the URL; `ClockSceneView` and
`ClockRenderer` both take it as an option.

## Where the numbers live

| Thing                                | Where                                   |
| ------------------------------------ | --------------------------------------- |
| Tick durations, overshoot, wind-down | `MechanismOptions` defaults             |
| Digit -> angle mapping               | `geometry/ringLayout.ts`                |
| Which digits a reading produces      | `time/countdown.ts` (`remainingDigits`) |
| Gear placement and speeds            | scene definitions (`GearSpec`)          |
| Escapement placement and size        | `clockScene.ts`, derived from the case  |
