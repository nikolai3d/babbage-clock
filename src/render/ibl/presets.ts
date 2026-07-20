/**
 * Discovery of the lighting-mood folders under `assets/ibl/`.
 *
 * Every mood is a folder holding a `preset.json` and the panorama it names.
 * `import.meta.glob` enumerates them at build time, so dropping a folder in adds
 * a mood with no code change — the registry philosophy applied to lighting.
 *
 * Both maps are *lazy*: the glob produces import functions, not modules, so
 * nothing here costs a byte of network or a millisecond of parsing until a mood
 * is actually asked for. That is what keeps a non-default preset off the
 * critical path to first paint.
 */

import { parseIblManifest } from './manifest.js';
import type { IblManifest } from './manifest.js';

/**
 * Patterns are *relative*, not root-absolute (`/assets/…`).
 *
 * Both forms resolve to the same files, but the glob keys are emitted into the
 * bundle verbatim, and a root-absolute key is a URL that 404s on a GitHub Pages
 * project page. `scripts/check-base-path.mjs` fails the build on exactly that,
 * and it is right to: nothing in a bundle should look like a site-root URL.
 * See docs/deploy.md.
 */
const PRESET_ROOT = '../../../assets/ibl';

const manifestLoaders = import.meta.glob('../../../assets/ibl/*/preset.json', {
  import: 'default',
}) as Record<string, () => Promise<unknown>>;

const panoramaLoaders = import.meta.glob('../../../assets/ibl/*/*.{hdr,exr,ktx2}', {
  query: '?url',
  import: 'default',
}) as Record<string, () => Promise<string>>;

/** `…/assets/ibl/night/preset.json` -> `night`. */
function folderOf(path: string): string {
  return path.split('/').slice(-2, -1)[0] ?? '';
}

/**
 * Folders whose name starts with this prefix are CI decode-path fixtures (e.g.
 * `test-uastc-hdr`), committed so the browser decode path can be exercised end
 * to end, but deliberately kept out of the picker and `?mood=`. Discovery lives
 * in this module, so the convention that marks a fixture does too — a picker or
 * whitelist sourced from `iblPresets` should filter on {@link isFixturePreset}
 * rather than re-deriving the prefix (which is what pinned it to the test file).
 */
const FIXTURE_PREFIX = 'test-';

/** Whether a preset id names a CI fixture rather than a shipped mood. */
export function isFixturePreset(id: string): boolean {
  return id.startsWith(FIXTURE_PREFIX);
}

export interface IblPresetEntry {
  readonly id: string;
  /** Parses `preset.json`. Rejects with `IblManifestError` if it is malformed. */
  loadManifest(): Promise<IblManifest>;
  /** Resolves the bundled, content-hashed URL of a file in this preset folder. */
  loadPanoramaUrl(file: string): Promise<string>;
}

/** Anything the environment controller can look a mood up in. Tests fake it. */
export interface IblPresetSource {
  get(id: string): IblPresetEntry | null;
  list(): readonly string[];
}

const entries = new Map<string, IblPresetEntry>();

for (const [path, load] of Object.entries(manifestLoaders)) {
  const id = folderOf(path);
  if (!id) continue;

  let manifest: Promise<IblManifest> | null = null;

  entries.set(id, {
    id,
    loadManifest(): Promise<IblManifest> {
      // Memoised: a manifest is parsed once even if two moods race for it.
      manifest ??= load().then((raw) => {
        const parsed = parseIblManifest(raw, path);
        if (parsed.id !== id) {
          throw new Error(
            `IBL preset "${path}" declares id "${parsed.id}" but lives in folder "${id}"; ` +
              'the folder name is the id used by ?mood= and must match.',
          );
        }
        return parsed;
      });
      return manifest;
    },
    loadPanoramaUrl(file: string): Promise<string> {
      const key = `${PRESET_ROOT}/${id}/${file}`;
      const loader = panoramaLoaders[key];
      if (!loader) {
        return Promise.reject(
          new Error(
            `IBL preset "${id}" names "${file}", which is not in its folder. ` +
              `Known files: ${Object.keys(panoramaLoaders)
                .filter((candidate) => candidate.startsWith(`${PRESET_ROOT}/${id}/`))
                .join(', ')}`,
          ),
        );
      }
      return loader();
    },
  });
}

/** The moods found on disk, in a stable order. */
export const iblPresets: IblPresetSource = {
  get: (id) => entries.get(id) ?? null,
  list: () => [...entries.keys()].sort(),
};
