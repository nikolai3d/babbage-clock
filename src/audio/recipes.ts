/**
 * What the mechanism sounds like, as data.
 *
 * No samples. Sourcing CC0 recordings would mean licences, payload and a
 * download the opt-in gate exists to avoid — and this project already builds
 * its gears, glyphs and materials procedurally. The sounds follow suit: every
 * tick, clunk and bell is a small score of synthesis directives, and this
 * module — pure maths, no Web Audio — decides those scores. The engine only
 * performs them, which is what makes the sound design unit-testable headless.
 *
 * Scheduling rides the same numbers the animation uses: a sound lands at the
 * event's travel end (`atMs + durationMs`), so audio and picture cannot drift
 * — they are two renderings of one event.
 */

export interface NoiseBurst {
  readonly kind: 'noise';
  /** Offset from the event's arrival instant, ms. */
  readonly atMs: number;
  /** Bandpass centre, Hz. */
  readonly frequency: number;
  readonly decayMs: number;
  readonly gain: number;
}

export interface Partial {
  readonly kind: 'partial';
  readonly atMs: number;
  readonly frequency: number;
  readonly decayMs: number;
  readonly gain: number;
}

export type Sound = NoiseBurst | Partial;

/** The subset of a mechanism event the sound design reads. */
export interface AudibleEvent {
  readonly kind: 'tick' | 'seek' | 'expire';
  readonly durationMs: number;
  /** Rings left of the seconds ring that moved; 0 is a plain second. */
  readonly carryDepth: number;
}

/**
 * Deterministic per-call variation, seeded by the caller.
 *
 * A metronome of identical clicks turns into noise the ear tunes out; a few
 * percent of detune keeps it mechanical. The jitter is a pure function of the
 * seed so a test can pin it.
 */
function detune(seed: number): number {
  const wobble = Math.sin(seed * 127.1) * 43758.5453;
  return 1 + (wobble - Math.floor(wobble) - 0.5) * 0.06;
}

/**
 * The score for one mechanism event. Empty for anything inaudible.
 *
 * - `seek` is silent: it is a correction, not a tick (docs/mechanism.md).
 * - A tick is a ratchet click (filtered noise) plus a faint metallic ring.
 * - A carry adds one low thunk whose weight grows with depth — a cascade is
 *   one coordinated release, so it must sound like one heavier event, never
 *   like `carryDepth` clicks machine-gunned together.
 * - Expiry is the final tick and then a struck bell: four inharmonic partials,
 *   because a harmonic stack sounds like an organ, not a bell.
 */
export function scoreFor(event: AudibleEvent, seed = 0): Sound[] {
  if (event.kind === 'seek') return [];

  const arrival = event.durationMs;
  const vary = detune(seed);
  const score: Sound[] = [
    { kind: 'noise', atMs: arrival, frequency: 3200 * vary, decayMs: 28, gain: 0.5 },
    { kind: 'partial', atMs: arrival, frequency: 2093 * vary, decayMs: 110, gain: 0.08 },
  ];

  if (event.carryDepth > 0) {
    // log2 weighting: each doubling of depth adds the same felt increment.
    const weight = Math.min(1, 0.35 + Math.log2(1 + event.carryDepth) * 0.22);
    score.push({
      kind: 'noise',
      atMs: arrival,
      frequency: 140 * vary,
      decayMs: 90 + event.carryDepth * 12,
      gain: weight,
    });
  }

  if (event.kind === 'expire') {
    const base = 220 * vary;
    for (const [index, ratio] of [1, 2.76, 5.4, 8.93].entries()) {
      score.push({
        kind: 'partial',
        atMs: arrival + 300,
        frequency: base * ratio,
        decayMs: 2600 / (index + 1),
        gain: 0.22 / (index + 1),
      });
    }
  }

  return score;
}
