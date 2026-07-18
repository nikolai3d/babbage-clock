import { describe, expect, it, vi } from 'vitest';
import { LoadingTracker } from './loading.js';

describe('LoadingTracker', () => {
  it('reports done when nothing has registered', () => {
    const snapshot = new LoadingTracker().getSnapshot();
    expect(snapshot).toMatchObject({ progress: 1, done: true, label: 'Ready', pending: [] });
  });

  it('weights tasks against each other', () => {
    const tracker = new LoadingTracker();
    const heavy = tracker.task('textures', { label: 'Textures', weight: 3 });
    tracker.task('time', { label: 'Time' });

    heavy.done();
    expect(tracker.getSnapshot().progress).toBeCloseTo(0.75);
    expect(tracker.getSnapshot().done).toBe(false);
  });

  it('captions with the first outstanding task', () => {
    const tracker = new LoadingTracker();
    const first = tracker.task('a', { label: 'Assembling' });
    tracker.task('b', { label: 'Checking time' });

    expect(tracker.getSnapshot().label).toBe('Assembling');
    first.done();
    expect(tracker.getSnapshot().label).toBe('Checking time');
    expect(tracker.getSnapshot().pending).toEqual(['b']);
  });

  it('never walks progress backwards', () => {
    const tracker = new LoadingTracker();
    const task = tracker.task('a', { label: 'A' });

    task.progress(0.6);
    task.progress(0.2);
    expect(tracker.getSnapshot().progress).toBeCloseTo(0.6);
  });

  it('clamps out-of-range and non-finite fractions', () => {
    const tracker = new LoadingTracker();
    const task = tracker.task('a', { label: 'A' });

    task.progress(Number.NaN);
    expect(tracker.getSnapshot().progress).toBe(0);
    task.progress(4);
    expect(tracker.getSnapshot()).toMatchObject({ progress: 1, done: true });
  });

  it('does not double-count a re-registered id', () => {
    const tracker = new LoadingTracker();
    tracker.task('a', { label: 'A' });
    const again = tracker.task('a', { label: 'A again' });

    again.done();
    expect(tracker.getSnapshot()).toMatchObject({ progress: 1, done: true });
  });

  it('notifies subscribers immediately and on every change', () => {
    const tracker = new LoadingTracker();
    const listener = vi.fn();
    const unsubscribe = tracker.subscribe(listener);
    expect(listener).toHaveBeenCalledTimes(1);

    const task = tracker.task('a', { label: 'A' });
    task.progress(0.5);
    task.done();
    expect(listener).toHaveBeenCalledTimes(4);

    unsubscribe();
    tracker.task('b', { label: 'B' }).done();
    expect(listener).toHaveBeenCalledTimes(4);
  });

  it('ignores repeated completion', () => {
    const tracker = new LoadingTracker();
    const listener = vi.fn();
    const task = tracker.task('a', { label: 'A' });
    tracker.subscribe(listener);

    task.done();
    task.done();
    expect(listener).toHaveBeenCalledTimes(2);
  });
});
