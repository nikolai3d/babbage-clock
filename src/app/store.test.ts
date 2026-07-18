import { describe, expect, it, vi } from 'vitest';
import { Store } from './store.js';
import { readLaunchParams } from './urlParams.js';

interface TestState {
  count: number;
  label: string;
}

describe('Store', () => {
  it('delivers the current state on subscribe', () => {
    const store = new Store<TestState>({ count: 1, label: 'a' });
    const listener = vi.fn();

    store.subscribe(listener);

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener.mock.calls[0]?.[0]).toEqual({ count: 1, label: 'a' });
  });

  it('notifies on change and merges patches immutably', () => {
    const store = new Store<TestState>({ count: 1, label: 'a' });
    const initial = store.get();
    const listener = vi.fn();
    store.subscribe(listener);

    store.set({ count: 2 });

    expect(store.get()).toEqual({ count: 2, label: 'a' });
    expect(initial).toEqual({ count: 1, label: 'a' });
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('does not notify when nothing actually changed', () => {
    const store = new Store<TestState>({ count: 1, label: 'a' });
    const listener = vi.fn();
    store.subscribe(listener);

    store.set({ count: 1 });
    store.set({});

    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('stops notifying after unsubscribe and after dispose', () => {
    const store = new Store<TestState>({ count: 0, label: 'a' });
    const first = vi.fn();
    const second = vi.fn();

    const unsubscribe = store.subscribe(first);
    store.subscribe(second);
    unsubscribe();
    store.set({ count: 1 });

    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(2);

    store.dispose();
    store.set({ count: 2 });

    expect(second).toHaveBeenCalledTimes(2);
  });

  it('survives a listener unsubscribing during notification', () => {
    const store = new Store<TestState>({ count: 0, label: 'a' });
    const second = vi.fn();

    // Held in a box because subscribe delivers the initial state synchronously,
    // so the listener runs before the unsubscribe handle exists.
    const first: { unsubscribe?: () => void } = {};
    first.unsubscribe = store.subscribe(() => {
      first.unsubscribe?.();
    });
    store.subscribe(second);

    expect(() => {
      store.set({ count: 1 });
    }).not.toThrow();
    expect(second).toHaveBeenCalledTimes(2);
  });
});

describe('readLaunchParams', () => {
  it('extracts the scene and target parameters', () => {
    expect(readLaunchParams('?scene=slate-orrery&target=2030-01-01')).toEqual({
      sceneId: 'slate-orrery',
      target: '2030-01-01',
      tz: null,
      mood: null,
      background: null,
      mode: null,
      hours12: false,
      quality: 'auto',
    });
  });

  it('extracts the timezone that a zone-less target is expressed in', () => {
    expect(readLaunchParams('?target=2026-12-31T23:59:59&tz=Europe/Paris')).toEqual({
      sceneId: null,
      target: '2026-12-31T23:59:59',
      tz: 'Europe/Paris',
      mood: null,
      background: null,
      mode: null,
      hours12: false,
      quality: 'auto',
    });
  });

  it('returns nulls when parameters are absent', () => {
    expect(readLaunchParams('')).toEqual({
      sceneId: null,
      target: null,
      tz: null,
      mood: null,
      background: null,
      mode: null,
      hours12: false,
      quality: 'auto',
    });
  });
});
