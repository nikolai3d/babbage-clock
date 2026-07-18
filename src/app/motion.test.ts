import { describe, expect, it, vi } from 'vitest';
import { MotionPreference, prefersReducedMotion, resolveMotion } from './motion.js';
import type { MediaQueryLike } from './motion.js';

/** A `MediaQueryList` stand-in whose `matches` can be flipped from a test. */
function fakeQuery(matches: boolean): MediaQueryLike & { flip: (value: boolean) => void } {
  const listeners = new Set<() => void>();
  const query = {
    matches,
    addEventListener: (_type: 'change', listener: () => void) => {
      listeners.add(listener);
    },
    removeEventListener: (_type: 'change', listener: () => void) => {
      listeners.delete(listener);
    },
    flip: (value: boolean) => {
      query.matches = value;
      for (const listener of [...listeners]) listener();
    },
  };
  return query;
}

describe('resolveMotion', () => {
  it('runs motion only when neither the hook nor the viewer objects', () => {
    expect(resolveMotion(true, false)).toBe(true);
    expect(resolveMotion(true, true)).toBe(false);
    expect(resolveMotion(false, false)).toBe(false);
    expect(resolveMotion(false, true)).toBe(false);
  });
});

describe('prefersReducedMotion', () => {
  it('is false where matchMedia is absent', () => {
    expect(prefersReducedMotion(null)).toBe(false);
  });

  it('is false when the query throws rather than reporting no match', () => {
    expect(
      prefersReducedMotion(() => {
        throw new Error('unsupported query');
      }),
    ).toBe(false);
  });

  it('reports the query result', () => {
    expect(prefersReducedMotion(() => fakeQuery(true))).toBe(true);
    expect(prefersReducedMotion(() => fakeQuery(false))).toBe(false);
  });
});

describe('MotionPreference', () => {
  it('leaves motion on by default', () => {
    const preference = new MotionPreference(true, () => fakeQuery(false));
    expect(preference.enabled).toBe(true);
    expect(preference.reducedMotion).toBe(false);
  });

  it('switches motion off for prefers-reduced-motion alone', () => {
    const preference = new MotionPreference(true, () => fakeQuery(true));
    expect(preference.enabled).toBe(false);
    expect(preference.reducedMotion).toBe(true);
  });

  it('switches motion off for ?nomotion alone', () => {
    const preference = new MotionPreference(false, () => fakeQuery(false));
    expect(preference.enabled).toBe(false);
    // The viewer did not ask for this; the hook did.
    expect(preference.reducedMotion).toBe(false);
  });

  it('notifies subscribers when the media query changes', () => {
    const query = fakeQuery(false);
    const preference = new MotionPreference(true, () => query);
    const listener = vi.fn();
    preference.subscribe(listener);

    query.flip(true);
    expect(listener).toHaveBeenCalledWith(false);
    expect(preference.enabled).toBe(false);

    query.flip(false);
    expect(listener).toHaveBeenLastCalledWith(true);
    expect(preference.enabled).toBe(true);
  });

  it('keeps ?nomotion winning over a media-query change', () => {
    const query = fakeQuery(true);
    const preference = new MotionPreference(false, () => query);
    const listener = vi.fn();
    preference.subscribe(listener);

    // The viewer turned reduced motion off, but the hook is still in force, so
    // the effective value never changes and nothing is notified.
    query.flip(false);
    expect(preference.enabled).toBe(false);
    expect(listener).not.toHaveBeenCalled();
  });

  it('stops listening after dispose', () => {
    const query = fakeQuery(false);
    const preference = new MotionPreference(true, () => query);
    const listener = vi.fn();
    preference.subscribe(listener);

    preference.dispose();
    query.flip(true);
    expect(listener).not.toHaveBeenCalled();
  });

  it('works without matchMedia at all', () => {
    const preference = new MotionPreference(true, null);
    expect(preference.enabled).toBe(true);
    expect(() => {
      preference.dispose();
    }).not.toThrow();
  });
});
