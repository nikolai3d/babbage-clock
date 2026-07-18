/**
 * The one motion switch.
 *
 * Two things want to turn continuous animation off — the viewer's
 * `prefers-reduced-motion` setting and the `?nomotion=1` test hook — and there
 * is deliberately **one** code path for both: they are combined here into a
 * single boolean, which is what `ClockRenderer` (and through it `Mechanism`)
 * consumes. Nothing downstream reads the media query or the query parameter on
 * its own; if you find yourself adding a second check, wire it in here instead.
 *
 * No DOM is required: `matchMedia` is injected, so the combining rule and the
 * subscription are unit-testable in the Node test environment.
 */

export const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)';

/** The slice of `MediaQueryList` this module uses. */
export interface MediaQueryLike {
  readonly matches: boolean;
  addEventListener?: (type: 'change', listener: () => void) => void;
  removeEventListener?: (type: 'change', listener: () => void) => void;
}

export type MatchMedia = (query: string) => MediaQueryLike | null;

/**
 * The combining rule, in one place: motion runs only when the viewer has not
 * asked for less of it **and** no test hook has switched it off.
 */
export function resolveMotion(hookMotion: boolean, reducedMotion: boolean): boolean {
  return hookMotion && !reducedMotion;
}

/** Reads `prefers-reduced-motion` defensively; false wherever it is unknown. */
export function prefersReducedMotion(matchMedia: MatchMedia | null): boolean {
  if (!matchMedia) return false;
  try {
    return matchMedia(REDUCED_MOTION_QUERY)?.matches === true;
  } catch {
    // Old engines throw on an unsupported query rather than reporting no match.
    return false;
  }
}

function defaultMatchMedia(): MatchMedia | null {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return null;
  return (query) => window.matchMedia(query);
}

/**
 * The effective motion setting, kept current.
 *
 * The viewer can flip `prefers-reduced-motion` while the page is open — on
 * macOS and iOS it is a single toggle in System Settings — so this listens for
 * the change rather than sampling once at boot. Subscribers get the new
 * effective value; `?nomotion=1` still wins, because a deterministic capture
 * must not depend on the host's accessibility settings.
 */
export class MotionPreference {
  private readonly query: MediaQueryLike | null;
  private readonly listeners = new Set<(enabled: boolean) => void>();
  private current: boolean;

  constructor(
    private readonly hookMotion: boolean,
    matchMedia: MatchMedia | null = defaultMatchMedia(),
  ) {
    let query: MediaQueryLike | null = null;
    try {
      query = matchMedia?.(REDUCED_MOTION_QUERY) ?? null;
    } catch {
      query = null;
    }
    this.query = query;
    this.current = resolveMotion(hookMotion, query?.matches === true);
    this.query?.addEventListener?.('change', this.onChange);
  }

  /** True when continuous animation should run. */
  get enabled(): boolean {
    return this.current;
  }

  /** True when the viewer's own setting is what switched motion off. */
  get reducedMotion(): boolean {
    return this.query?.matches === true;
  }

  /** Notified only when the effective value actually changes. */
  subscribe(listener: (enabled: boolean) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  dispose(): void {
    this.query?.removeEventListener?.('change', this.onChange);
    this.listeners.clear();
  }

  private readonly onChange = (): void => {
    const next = resolveMotion(this.hookMotion, this.query?.matches === true);
    if (next === this.current) return;
    this.current = next;
    for (const listener of [...this.listeners]) listener(next);
  };
}
