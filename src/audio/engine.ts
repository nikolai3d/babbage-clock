/**
 * Performs the scores `recipes.ts` writes, and nothing else.
 *
 * The context is created by the caller inside the settings-toggle click, which
 * is what satisfies the autoplay policy: the toggle *is* the unlock gesture.
 * Nothing here runs before that, no asset is fetched ever (the sounds are
 * synthesised), and disposal closes the context so a toggled-off session
 * holds no audio resources at all.
 */

import { scoreFor, type AudibleEvent } from './recipes.js';

const MASTER_GAIN = 0.5;

export class AudioEngine {
  private readonly context: AudioContext;
  private readonly master: GainNode;
  /** One shared noise buffer; every burst plays a slice of it. */
  private readonly noise: AudioBuffer;
  private seed = 0;
  private disposed = false;

  constructor(context: AudioContext) {
    this.context = context;
    this.master = context.createGain();
    this.master.gain.value = MASTER_GAIN;
    this.master.connect(context.destination);

    const length = context.sampleRate;
    this.noise = context.createBuffer(1, length, context.sampleRate);
    const channel = this.noise.getChannelData(0);
    for (let i = 0; i < length; i += 1) channel[i] = Math.random() * 2 - 1;
  }

  /** Renders one mechanism event's score. Safe to call after dispose (no-op). */
  play(event: AudibleEvent): void {
    if (this.disposed || this.context.state !== 'running') return;
    this.seed += 1;

    const startAt = this.context.currentTime;
    for (const sound of scoreFor(event, this.seed)) {
      const at = startAt + sound.atMs / 1000;
      const decay = sound.decayMs / 1000;

      const envelope = this.context.createGain();
      envelope.gain.setValueAtTime(sound.gain, at);
      envelope.gain.exponentialRampToValueAtTime(1e-4, at + decay);
      envelope.connect(this.master);

      if (sound.kind === 'noise') {
        const source = this.context.createBufferSource();
        source.buffer = this.noise;
        const filter = this.context.createBiquadFilter();
        filter.type = 'bandpass';
        filter.frequency.value = sound.frequency;
        filter.Q.value = 1.4;
        source.connect(filter);
        filter.connect(envelope);
        source.start(at, Math.random(), decay + 0.05);
        source.stop(at + decay + 0.05);
      } else {
        const oscillator = this.context.createOscillator();
        oscillator.type = 'sine';
        oscillator.frequency.value = sound.frequency;
        oscillator.connect(envelope);
        oscillator.start(at);
        oscillator.stop(at + decay + 0.05);
      }
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.master.disconnect();
    void this.context.close().catch(() => undefined);
  }
}
