import { parseQualityPreference } from './quality.js';

/**
 * How the viewer wants the scene's backdrop drawn.
 *
 * `auto` defers to the quality tier (panorama on high, the mood's authored
 * gradient on low); the other two override the tier in either direction. The
 * gradient override is always safe; forcing the panorama on a low-tier device
 * spends exactly the cost the tier tried to save, and that is the viewer's
 * call to make — the tier is a default, not a policy.
 */
export type BackgroundPreference = 'auto' | 'panorama' | 'backdrop';

/** What the rings read out; null defers to the scene's own mode. */
export type ClockModePreference = 'countdown' | 'clock';

export function parseClockMode(raw: string | null | undefined): ClockModePreference | null {
  if (raw === null || raw === undefined) return null;
  const value = raw.trim().toLowerCase();
  return value === 'clock' || value === 'countdown' ? value : null;
}

/** `auto` for anything unrecognised, exactly like an unknown `?scene=`. */
export function parseBackgroundPreference(
  raw: string | null | undefined,
): BackgroundPreference | null {
  if (raw === null || raw === undefined) return null;
  const value = raw.trim().toLowerCase();
  return value === 'panorama' || value === 'backdrop' ? value : null;
}
import { parseEnvironmentPreset } from '../scene/environment.js';
import { resolveTarget } from '../time/target.js';
import type { QualityPreference } from './quality.js';
import type { EnvironmentPresetId } from '../scene/types.js';
import type { ResolvedTarget } from '../time/target.js';

/** Canonical query-parameter names, so beads do not invent variants. */
export const URL_PARAM = {
  scene: 'scene',
  target: 'target',
  tz: 'tz',
  mood: 'mood',
  background: 'bg',
  mode: 'mode',
  hours12: 'h12',
  quality: 'quality',
} as const;

export interface LaunchParams {
  readonly sceneId: string | null;
  readonly target: string | null;
  /**
   * IANA zone id or fixed offset the `target` wall clock is expressed in, e.g.
   * `?target=2026-12-31T23:59:59&tz=Europe/Paris`. Absent means the viewer's
   * own zone; ignored when `target` already carries an offset.
   */
  readonly tz: string | null;
  /**
   * Lighting mood override (`?mood=steampunk-workshop`). Null means "use the
   * preset the scene declares"; an unrecognised value is treated as absent
   * rather than as an error, exactly like an unknown `?scene=`.
   */
  readonly mood: EnvironmentPresetId | null;
  /**
   * Background override (`?bg=panorama` or `?bg=backdrop`). Null means
   * "automatic": the quality tier decides, which is the shipped default.
   */
  readonly background: BackgroundPreference | null;
  /** `?mode=clock|countdown`. Null defers to the scene's own mode. */
  readonly mode: ClockModePreference | null;
  /** `?h12` — 12-hour form with a meridiem, for clock mode. */
  readonly hours12: boolean;
  /**
   * Render-quality override (`?quality=low|high`). `auto` — the default and the
   * value any unrecognised input maps to — leaves the tier to the device
   * heuristic in `app/quality.ts`.
   *
   * Deliberately **not** part of {@link ShareableState}: a tier is a property of
   * the device it was chosen on, and sending "low quality" to whoever opens the
   * link would be nonsense. It is readable so a test, a bug report or a curious
   * viewer can pin it.
   */
  readonly quality: QualityPreference;
}

export function readLaunchParams(search: string): LaunchParams {
  const params = new URLSearchParams(search);
  return {
    sceneId: params.get(URL_PARAM.scene),
    target: params.get(URL_PARAM.target),
    tz: params.get(URL_PARAM.tz),
    mood: parseEnvironmentPreset(params.get(URL_PARAM.mood)),
    background: parseBackgroundPreference(params.get(URL_PARAM.background)),
    mode: parseClockMode(params.get(URL_PARAM.mode)),
    hours12: params.get(URL_PARAM.hours12) === '1',
    quality: parseQualityPreference(params.get(URL_PARAM.quality)),
  };
}

/** Everything a link has to carry to reproduce what the viewer is looking at. */
export interface ShareableState {
  readonly sceneId: string;
  readonly target: ResolvedTarget;
  readonly mood: EnvironmentPresetId | null;
  readonly background: BackgroundPreference | null;
  readonly mode: ClockModePreference | null;
  readonly hours12: boolean;
}

/**
 * The query parameters describing `state`.
 *
 * The target is written as the wall clock in the zone it was entered in, plus
 * that zone — never as an epoch or a bare UTC instant. That keeps the link
 * readable and it round-trips exactly: re-resolving the pair yields the same
 * instant, including across a DST gap (the echoed wall clock is the adjusted
 * one) and an overlap (re-resolution picks the same earlier instant again).
 * The one exception — a target pinned to the *later* side of an overlap — is
 * handled in {@link shareTargetValue}.
 *
 * The target is always written, even when it is the default New Year, so a
 * recipient in another zone sees the sender's countdown rather than their own.
 */
export function buildShareParams(state: ShareableState): URLSearchParams {
  const params = new URLSearchParams();
  params.set(URL_PARAM.target, shareTargetValue(state.target));
  params.set(URL_PARAM.tz, state.target.zone);
  params.set(URL_PARAM.scene, state.sceneId);
  if (state.mood !== null) params.set(URL_PARAM.mood, state.mood);
  if (state.background !== null && state.background !== 'auto') {
    params.set(URL_PARAM.background, state.background);
  }
  if (state.mode !== null) params.set(URL_PARAM.mode, state.mode);
  if (state.hours12) params.set(URL_PARAM.hours12, '1');
  return params;
}

/**
 * The `?target=` value that reproduces `target.atMs` exactly.
 *
 * Normally the bare wall clock in the entered zone — the readable form. The
 * one pair that cannot round-trip that way is a target pinned to the *later*
 * side of a DST fall-back overlap, where re-resolving the wall clock takes
 * the earlier instant, an hour off. That state is reachable: the clock-mode
 * zone control re-anchors the existing instant into an arbitrary zone
 * (`retargetZone`), and an offset-carrying launch URL can land there too.
 * Exactly then the UTC offset is appended, which the resolver reads as an
 * absolute instant; `?tz=` still names the zone for display. Slightly less
 * pretty, never wrong.
 */
function shareTargetValue(target: ResolvedTarget): string {
  const { wallClock, offset } = target.enteredZone;
  try {
    // The probe only consults `atMs`, but its inputs are pinned anyway so the
    // check is hermetic — no ambient clock or machine zone even incidentally.
    const probe = resolveTarget({
      value: wallClock,
      zone: target.zone,
      nowMs: target.atMs,
      viewerZone: target.zone,
    });
    if (probe.atMs === target.atMs) return wallClock;
  } catch {
    // A pair that cannot re-resolve at all cannot use the readable form.
  }
  return `${wallClock}${offset}`;
}

/**
 * An absolute shareable URL for `state`, built on `baseHref`.
 *
 * Any existing query string and fragment on `baseHref` is dropped: parameters
 * belonging to other tools (test hooks, campaign tags) are nobody's business
 * once the link leaves this browser.
 */
export function buildShareUrl(baseHref: string, state: ShareableState): string {
  const url = new URL(baseHref);
  url.hash = '';
  url.search = readableQuery(buildShareParams(state));
  return url.toString();
}

/**
 * `URLSearchParams` percent-encodes `:` and `/`, which turns a perfectly
 * readable timestamp into `2026-12-31T23%3A59%3A59&tz=Europe%2FParis`. Both are
 * legal unescaped in a query (RFC 3986 `pchar`), and this string is shown to a
 * human and pasted by hand, so they are put back. `%2B` deliberately stays
 * encoded: a bare `+` in a query means a space, and fixed-offset zones use it.
 */
function readableQuery(params: URLSearchParams): string {
  return params.toString().replace(/%3A/g, ':').replace(/%2F/g, '/');
}

/**
 * Rewrites the address bar to match `state` without reloading.
 *
 * Unlike `buildShareUrl` this preserves unrelated parameters, because they may
 * be driving the session (test hooks, for instance). `replaceState` rather than
 * `pushState`: changing a setting should not stack up history entries the back
 * button has to walk through.
 */
export function writeAppParams(state: ShareableState): void {
  const url = new URL(window.location.href);
  for (const [key, value] of buildShareParams(state)) url.searchParams.set(key, value);
  if (state.mood === null) url.searchParams.delete(URL_PARAM.mood);
  if (state.background === null || state.background === 'auto') {
    url.searchParams.delete(URL_PARAM.background);
  }
  if (state.mode === null) url.searchParams.delete(URL_PARAM.mode);
  if (!state.hours12) url.searchParams.delete(URL_PARAM.hours12);
  url.search = readableQuery(url.searchParams);
  window.history.replaceState(null, '', url);
}

/**
 * Rewrites `?scene=` alone. Retained from the scaffold for callers that change
 * nothing else; `writeAppParams` is the general form.
 */
export function writeSceneParam(sceneId: string): void {
  const url = new URL(window.location.href);
  url.searchParams.set(URL_PARAM.scene, sceneId);
  window.history.replaceState(null, '', url);
}
