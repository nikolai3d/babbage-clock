/**
 * Transient confirmations ("Link copied").
 *
 * One live region for the whole app, `role="status"` so a screen reader
 * announces the message without stealing focus. Every timer is tracked and
 * cleared in `dispose()`, because this outlives individual panels.
 */

export type ToastTone = 'ok' | 'error';

export interface ToastOptions {
  readonly tone?: ToastTone;
  /** How long the toast stays up. Defaults to 2.6 s. */
  readonly durationMs?: number;
}

const DEFAULT_DURATION_MS = 2_600;
/** Must match the `.toast` transition in styles.css. */
const FADE_MS = 220;

export class ToastRegion {
  private readonly root: HTMLDivElement;
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();

  constructor(container: HTMLElement) {
    this.root = document.createElement('div');
    this.root.className = 'toast-region';
    this.root.setAttribute('role', 'status');
    this.root.setAttribute('aria-live', 'polite');
    container.append(this.root);
  }

  show(message: string, options: ToastOptions = {}): void {
    const toast = document.createElement('div');
    toast.className = `toast toast--${options.tone ?? 'ok'}`;
    toast.textContent = message;
    this.root.append(toast);

    // Next frame, so the element is in the document with its initial style
    // before the transition target is applied — otherwise it appears instantly.
    this.after(0, () => toast.classList.add('toast--visible'));
    this.after(options.durationMs ?? DEFAULT_DURATION_MS, () => {
      toast.classList.remove('toast--visible');
      this.after(FADE_MS, () => toast.remove());
    });
  }

  dispose(): void {
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
    this.root.remove();
  }

  private after(delayMs: number, run: () => void): void {
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      run();
    }, delayMs);
    this.timers.add(timer);
  }
}
