/** Canonical query-parameter names, so beads do not invent variants. */
export const URL_PARAM = {
  scene: 'scene',
  target: 'target',
} as const;

export interface LaunchParams {
  readonly sceneId: string | null;
  readonly target: string | null;
}

export function readLaunchParams(search: string): LaunchParams {
  const params = new URLSearchParams(search);
  return {
    sceneId: params.get(URL_PARAM.scene),
    target: params.get(URL_PARAM.target),
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
