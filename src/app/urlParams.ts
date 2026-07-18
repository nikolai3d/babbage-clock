/** Canonical query-parameter names, so beads do not invent variants. */
export const URL_PARAM = {
  scene: 'scene',
  target: 'target',
  tz: 'tz',
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
}

export function readLaunchParams(search: string): LaunchParams {
  const params = new URLSearchParams(search);
  return {
    sceneId: params.get(URL_PARAM.scene),
    target: params.get(URL_PARAM.target),
    tz: params.get(URL_PARAM.tz),
  };
}

/**
 * Rewrites `?scene=` without reloading, so the current view stays shareable.
 * `replaceState` rather than `pushState`: scene switching should not stack up
 * history entries the back button has to walk through.
 */
export function writeSceneParam(sceneId: string): void {
  const url = new URL(window.location.href);
  url.searchParams.set(URL_PARAM.scene, sceneId);
  window.history.replaceState(null, '', url);
}
