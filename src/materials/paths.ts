/**
 * Where material folders live, and how their URLs are built.
 *
 * Material textures are fetched at *runtime*, so Vite never sees them as
 * imports and never rewrites their paths. Everything therefore has to be joined
 * onto `import.meta.env.BASE_URL` by hand — a deployment under a sub-path (the
 * GitHub Pages site lives at `/babbage-clock/`) 404s on every texture otherwise.
 *
 * Folders sit in `public/assets/materials/<id>/`, which Vite copies verbatim
 * into `dist/`. Dropping a folder in there is the whole install procedure: no
 * build step, no registration, no code change.
 */

/** URL prefix, relative to the app base, under which material folders live. */
export const MATERIAL_ROOT = 'assets/materials/';

/** Filename of the manifest inside a material folder. */
export const MANIFEST_FILENAME = 'material.json';

/**
 * Directory holding the KTX2/BasisU transcoder, relative to the app base.
 *
 * Populated from `node_modules/three` by `scripts/sync-basis-transcoder.mjs`
 * (wired to `predev`/`prebuild`), so the binaries are never committed.
 */
export const BASIS_TRANSCODER_PATH = 'basis/';

/** The app's base path, with a guaranteed trailing slash. */
export function appBaseUrl(): string {
  const base = typeof import.meta.env?.BASE_URL === 'string' ? import.meta.env.BASE_URL : '/';
  return base.endsWith('/') ? base : `${base}/`;
}

/**
 * Joins a runtime asset path onto the app base.
 *
 * Absolute URLs and data URIs are returned untouched, so a manifest may point
 * at a CDN if it ever needs to.
 */
export function resolveAssetUrl(path: string, base: string = appBaseUrl()): string {
  if (/^(?:[a-z]+:)?\/\//i.test(path) || path.startsWith('data:') || path.startsWith('blob:')) {
    return path;
  }
  const suffix = path.startsWith('/') ? path.slice(1) : path;
  return `${base}${suffix}`;
}

/** Folder URL for a material id, with a trailing slash. */
export function materialFolderUrl(id: string, base?: string): string {
  return resolveAssetUrl(`${MATERIAL_ROOT}${id}/`, base);
}

/** URL of a file inside a material folder. */
export function materialFileUrl(id: string, file: string, base?: string): string {
  return `${materialFolderUrl(id, base)}${file}`;
}
