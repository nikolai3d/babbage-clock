/**
 * The `preset.json` schema for a lighting mood, and its parser.
 *
 * A mood is content, not code — the same philosophy as the scene registry. A
 * preset is a folder under `assets/ibl/` holding a `preset.json` and the HDR
 * panorama it names; dropping a folder in adds a mood (see `docs/lighting.md`).
 *
 * This module is deliberately three.js-free and side-effect-free so the schema
 * can be validated in a plain Node test with no WebGL context. Colours are
 * authored as `#rrggbb` strings and parsed to numbers here, which is the last
 * point before `render/ibl/rig.ts` turns them into lights.
 */

/** Panorama encodings the loader knows how to turn into an environment map. */
export type IblEnvironmentFormat = 'rgbe' | 'exr' | 'ktx2';

/** Tone-mapping curves a mood may grade with. ACES is the project default. */
export type IblToneMapping = 'none' | 'linear' | 'reinhard' | 'cineon' | 'aces' | 'agx' | 'neutral';

export interface IblEnvironmentSpec {
  /** Panorama filename, resolved relative to the preset folder. */
  readonly file: string;
  readonly format: IblEnvironmentFormat;
  /** `scene.environmentIntensity` for this mood. */
  readonly intensity: number;
  /** Rotation about Y in radians, so a map can be aimed at the camera. */
  readonly rotation: number;
}

/**
 * The backdrop drawn when the environment map is *not* shown as the background.
 *
 * This is what keeps the shipped dark-workshop vignette achievable under any
 * IBL: the panorama still lights the scene, but the viewer sees a solid or
 * vertically graded backdrop instead of a photograph.
 */
export type IblBackgroundFallback =
  | { readonly kind: 'color'; readonly color: number }
  | {
      readonly kind: 'gradient';
      readonly top: number;
      readonly bottom: number;
      /** Curve applied to the vertical blend; > 1 pulls the light band upward. */
      readonly power: number;
    };

export interface IblBackgroundSpec {
  /** `environment` draws the panorama; `fallback` draws the backdrop below. */
  readonly mode: 'environment' | 'fallback';
  /** `scene.backgroundBlurriness`, 0-1. Ignored by the fallback backdrop. */
  readonly blurriness: number;
  /** `scene.backgroundIntensity`. Applies to both modes. */
  readonly intensity: number;
  readonly fallback: IblBackgroundFallback;
}

export interface IblGradeSpec {
  readonly exposure: number;
  readonly toneMapping: IblToneMapping;
}

export interface IblFogSpec {
  readonly color: number;
  readonly near: number;
  readonly far: number;
}

interface IblLightBase {
  /** Used in the scene graph as `ibl:<preset>:<name>`; handy in a debugger. */
  readonly name: string;
  readonly color: number;
  readonly intensity: number;
}

/**
 * Shadow casting for a mood's key light.
 *
 * Authored per light because only a mood with a *real* key — a sun, a lamp —
 * has a shadow worth paying for; an omnidirectional fill casting would cost a
 * render pass to say nothing. The frustum is authored here too: the manifest
 * knows where its light sits and how much scene it must cover, and a frustum
 * derived at runtime would re-fit (and so re-alias) every time a scene grew a
 * part. Resolution is deliberately absent — that is the quality tier's knob,
 * threaded in by the renderer (see `app/quality.ts`).
 */
export interface IblShadowSpec {
  /** Half-extent of the orthographic shadow frustum, in scene units. */
  readonly radius: number;
  /** Near plane of the shadow camera, from the light along its direction. */
  readonly near: number;
  /** Far plane; must reach past the far side of the mechanism. */
  readonly far: number;
  /** Depth-test offset countering acne on parallel surfaces. */
  readonly bias: number;
  /** Offset along the surface normal countering acne on curved drums. */
  readonly normalBias: number;
}

export type IblLightSpec =
  | (IblLightBase & { readonly type: 'ambient' })
  | (IblLightBase & { readonly type: 'hemisphere'; readonly groundColor: number })
  | (IblLightBase & {
      readonly type: 'directional';
      readonly position: readonly [number, number, number];
      /** Present only on a light that casts; parsed and defaulted below. */
      readonly shadow?: IblShadowSpec;
    })
  | (IblLightBase & {
      readonly type: 'point';
      readonly position: readonly [number, number, number];
      readonly distance: number;
      readonly decay: number;
    })
  | (IblLightBase & {
      readonly type: 'spot';
      readonly position: readonly [number, number, number];
      readonly target: readonly [number, number, number];
      readonly distance: number;
      readonly decay: number;
      readonly angle: number;
      readonly penumbra: number;
    });

export interface IblSourceSpec {
  readonly title: string;
  readonly authors: readonly string[];
  readonly provider: string;
  readonly url: string;
  readonly licence: string;
  readonly resolution: string;
  readonly notes?: string;
}

/** A fully parsed, defaulted `preset.json`. */
export interface IblManifest {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly environment: IblEnvironmentSpec;
  readonly background: IblBackgroundSpec;
  readonly grade: IblGradeSpec;
  readonly fog: IblFogSpec | null;
  /**
   * How much of the scene's own analytic lighting survives while this mood is
   * active, 0-1. Moods ship a complete rig, so the default is 0: the mood owns
   * the lighting, and a scene's lights are its no-environment fallback.
   */
  readonly sceneLightScale: number;
  readonly lights: readonly IblLightSpec[];
  readonly source: IblSourceSpec;
}

const FORMATS = new Set<string>(['rgbe', 'exr', 'ktx2']);
const TONE_MAPPINGS = new Set<string>([
  'none',
  'linear',
  'reinhard',
  'cineon',
  'aces',
  'agx',
  'neutral',
]);

/** Thrown with every problem listed at once rather than failing on the first. */
export class IblManifestError extends Error {
  constructor(
    readonly where: string,
    readonly problems: readonly string[],
  ) {
    super(`Invalid IBL preset manifest (${where}):\n  - ${problems.join('\n  - ')}`);
    this.name = 'IblManifestError';
  }
}

/**
 * Validates and normalises a `preset.json`.
 *
 * `where` is only used in error messages — pass the path so a broken manifest
 * names itself. Optional fields are filled in here, so everything downstream
 * reads a complete manifest and never re-applies a default.
 */
export function parseIblManifest(raw: unknown, where: string): IblManifest {
  const problems: string[] = [];
  const root = asRecord(raw);
  if (!root) throw new IblManifestError(where, ['manifest is not an object']);

  const id = requireString(root, 'id', problems);
  const name = requireString(root, 'name', problems);
  const description = optionalString(root, 'description', problems) ?? '';

  const environment = parseEnvironment(root['environment'], problems);
  const background = parseBackground(root['background'], problems);
  const grade = parseGrade(root['grade'], problems);
  const fog = parseFog(root['fog'], problems);
  const sceneLightScale = clamp01(
    optionalNumber(root, 'sceneLightScale', problems) ?? 0,
    'sceneLightScale',
    problems,
  );
  const lights = parseLights(root['lights'], problems);
  const source = parseSource(root['source'], problems);

  if (problems.length > 0) throw new IblManifestError(where, problems);

  return {
    id,
    name,
    description,
    environment,
    background,
    grade,
    fog,
    sceneLightScale,
    lights,
    source,
  };
}

function parseEnvironment(raw: unknown, problems: string[]): IblEnvironmentSpec {
  const node = asRecord(raw);
  if (!node) {
    problems.push('environment: missing or not an object');
    return { file: '', format: 'rgbe', intensity: 1, rotation: 0 };
  }

  const file = requireString(node, 'file', problems, 'environment.');
  const formatRaw = optionalString(node, 'format', problems, 'environment.') ?? 'rgbe';
  if (!FORMATS.has(formatRaw)) {
    problems.push(`environment.format: "${formatRaw}" is not one of ${[...FORMATS].join(', ')}`);
  }
  const intensity = optionalNumber(node, 'intensity', problems, 'environment.') ?? 1;
  if (intensity < 0) problems.push('environment.intensity must be >= 0');

  return {
    file,
    format: (FORMATS.has(formatRaw) ? formatRaw : 'rgbe') as IblEnvironmentFormat,
    intensity,
    rotation: optionalNumber(node, 'rotation', problems, 'environment.') ?? 0,
  };
}

function parseBackground(raw: unknown, problems: string[]): IblBackgroundSpec {
  const node = asRecord(raw) ?? {};
  const modeRaw = optionalString(node, 'mode', problems, 'background.') ?? 'environment';
  if (modeRaw !== 'environment' && modeRaw !== 'fallback') {
    problems.push(`background.mode: "${modeRaw}" is not "environment" or "fallback"`);
  }

  return {
    mode: modeRaw === 'fallback' ? 'fallback' : 'environment',
    blurriness: clamp01(
      optionalNumber(node, 'blurriness', problems, 'background.') ?? 0,
      'background.blurriness',
      problems,
    ),
    intensity: optionalNumber(node, 'intensity', problems, 'background.') ?? 1,
    fallback: parseBackgroundFallback(node['fallback'], problems),
  };
}

function parseBackgroundFallback(raw: unknown, problems: string[]): IblBackgroundFallback {
  const node = asRecord(raw);
  // A preset that never falls back still needs one: a scene may set
  // `showAsBackground: false` under any mood. Black is the honest default.
  if (!node) return { kind: 'color', color: 0x000000 };

  const kind = optionalString(node, 'kind', problems, 'background.fallback.') ?? 'color';
  if (kind === 'gradient') {
    return {
      kind: 'gradient',
      top: requireColor(node, 'top', problems, 'background.fallback.'),
      bottom: requireColor(node, 'bottom', problems, 'background.fallback.'),
      power: optionalNumber(node, 'power', problems, 'background.fallback.') ?? 1,
    };
  }
  if (kind !== 'color') {
    problems.push(`background.fallback.kind: "${kind}" is not "color" or "gradient"`);
  }
  return { kind: 'color', color: requireColor(node, 'color', problems, 'background.fallback.') };
}

function parseGrade(raw: unknown, problems: string[]): IblGradeSpec {
  const node = asRecord(raw) ?? {};
  const toneMapping = optionalString(node, 'toneMapping', problems, 'grade.') ?? 'aces';
  if (!TONE_MAPPINGS.has(toneMapping)) {
    problems.push(
      `grade.toneMapping: "${toneMapping}" is not one of ${[...TONE_MAPPINGS].join(', ')}`,
    );
  }
  const exposure = optionalNumber(node, 'exposure', problems, 'grade.') ?? 1;
  if (exposure <= 0) problems.push('grade.exposure must be > 0');

  return {
    exposure,
    toneMapping: (TONE_MAPPINGS.has(toneMapping) ? toneMapping : 'aces') as IblToneMapping,
  };
}

function parseFog(raw: unknown, problems: string[]): IblFogSpec | null {
  if (raw === undefined || raw === null) return null;
  const node = asRecord(raw);
  if (!node) {
    problems.push('fog: not an object');
    return null;
  }
  const near = optionalNumber(node, 'near', problems, 'fog.') ?? 1;
  const far = optionalNumber(node, 'far', problems, 'fog.') ?? 100;
  if (far <= near) problems.push(`fog.far (${far}) must exceed fog.near (${near})`);
  return { color: requireColor(node, 'color', problems, 'fog.'), near, far };
}

function parseLights(raw: unknown, problems: string[]): IblLightSpec[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    problems.push('lights: not an array');
    return [];
  }

  const lights: IblLightSpec[] = [];
  raw.forEach((entry: unknown, index) => {
    const node = asRecord(entry);
    const at = `lights[${index}].`;
    if (!node) {
      problems.push(`lights[${index}]: not an object`);
      return;
    }

    const base = {
      name: optionalString(node, 'name', problems, at) ?? `light-${index}`,
      color: requireColor(node, 'color', problems, at),
      intensity: optionalNumber(node, 'intensity', problems, at) ?? 1,
    };
    const type = requireString(node, 'type', problems, at);

    switch (type) {
      case 'ambient':
        lights.push({ ...base, type: 'ambient' });
        return;
      case 'hemisphere':
        lights.push({
          ...base,
          type: 'hemisphere',
          groundColor: requireColor(node, 'groundColor', problems, at),
        });
        return;
      case 'directional': {
        const shadow = parseShadow(node['shadow'], at, problems);
        lights.push({
          ...base,
          type: 'directional',
          position: requireVec3(node, at, problems),
          // `exactOptionalPropertyTypes`: a light that does not cast has no
          // `shadow` key at all, not an explicit undefined.
          ...(shadow === null ? {} : { shadow }),
        });
        return;
      }
      case 'point':
        lights.push({
          ...base,
          type: 'point',
          position: requireVec3(node, at, problems),
          distance: optionalNumber(node, 'distance', problems, at) ?? 0,
          decay: optionalNumber(node, 'decay', problems, at) ?? 2,
        });
        return;
      case 'spot':
        lights.push({
          ...base,
          type: 'spot',
          position: requireVec3(node, at, problems),
          target: readVec3(node['target']) ?? [0, 0, 0],
          distance: optionalNumber(node, 'distance', problems, at) ?? 0,
          decay: optionalNumber(node, 'decay', problems, at) ?? 2,
          angle: optionalNumber(node, 'angle', problems, at) ?? Math.PI / 6,
          penumbra: clamp01(
            optionalNumber(node, 'penumbra', problems, at) ?? 0,
            `${at}penumbra`,
            problems,
          ),
        });
        return;
      default:
        problems.push(`${at}type: "${type}" is not a supported light type`);
    }
  });

  return lights;
}

/**
 * Optional per-light shadow block. `radius` is required — a guessed frustum is
 * either clipped or blocky, both worse than no shadow — and the fiddly acne
 * counters get defaults tuned for this project's roughly camera-sized scenes.
 */
function parseShadow(raw: unknown, at: string, problems: string[]): IblShadowSpec | null {
  if (raw === undefined || raw === null) return null;
  const node = asRecord(raw);
  if (!node) {
    problems.push(`${at}shadow: not an object`);
    return null;
  }

  const prefix = `${at}shadow.`;
  const radius = optionalNumber(node, 'radius', problems, prefix);
  if (radius === undefined || radius <= 0) {
    problems.push(`${prefix}radius: missing or not a positive number`);
  }
  const near = optionalNumber(node, 'near', problems, prefix) ?? 0.5;
  const far = optionalNumber(node, 'far', problems, prefix) ?? 50;
  if (near <= 0) problems.push(`${prefix}near must be > 0`);
  if (far <= near) problems.push(`${prefix}far (${far}) must exceed near (${near})`);

  return {
    radius: radius !== undefined && radius > 0 ? radius : 1,
    near,
    far,
    bias: optionalNumber(node, 'bias', problems, prefix) ?? -0.0002,
    normalBias: optionalNumber(node, 'normalBias', problems, prefix) ?? 0.02,
  };
}

function parseSource(raw: unknown, problems: string[]): IblSourceSpec {
  const node = asRecord(raw);
  if (!node) {
    // Provenance is not optional: an unattributed HDRI is one nobody can
    // audit, replace or clear for redistribution.
    problems.push('source: missing — every environment map must record its origin and licence');
    return { title: '', authors: [], provider: '', url: '', licence: '', resolution: '' };
  }

  const authorsRaw: unknown = node['authors'];
  const authors = Array.isArray(authorsRaw)
    ? authorsRaw.filter((a): a is string => typeof a === 'string')
    : [];
  if (authors.length === 0) problems.push('source.authors: at least one author is required');

  const notes = optionalString(node, 'notes', problems, 'source.');

  return {
    title: requireString(node, 'title', problems, 'source.'),
    authors,
    provider: requireString(node, 'provider', problems, 'source.'),
    url: requireString(node, 'url', problems, 'source.'),
    licence: requireString(node, 'licence', problems, 'source.'),
    resolution: optionalString(node, 'resolution', problems, 'source.') ?? 'unknown',
    // `exactOptionalPropertyTypes` is on, so an absent note must be an absent
    // key rather than an explicit undefined.
    ...(notes === undefined ? {} : { notes }),
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function requireString(
  node: Record<string, unknown>,
  key: string,
  problems: string[],
  prefix = '',
): string {
  const value: unknown = node[key];
  if (typeof value === 'string' && value.length > 0) return value;
  problems.push(`${prefix}${key}: missing or not a non-empty string`);
  return '';
}

function optionalString(
  node: Record<string, unknown>,
  key: string,
  problems: string[],
  prefix = '',
): string | undefined {
  const value: unknown = node[key];
  if (value === undefined) return undefined;
  if (typeof value === 'string') return value;
  problems.push(`${prefix}${key}: not a string`);
  return undefined;
}

function optionalNumber(
  node: Record<string, unknown>,
  key: string,
  problems: string[],
  prefix = '',
): number | undefined {
  const value: unknown = node[key];
  if (value === undefined) return undefined;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  problems.push(`${prefix}${key}: not a finite number`);
  return undefined;
}

function clamp01(value: number, label: string, problems: string[]): number {
  if (value < 0 || value > 1) {
    problems.push(`${label}: ${value} is outside [0, 1]`);
    return Math.min(1, Math.max(0, value));
  }
  return value;
}

/** Colours are authored as `#rrggbb` so a manifest reads like a palette. */
export function parseHexColor(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const match = /^#?([0-9a-fA-F]{6})$/.exec(value.trim());
  return match ? Number.parseInt(match[1]!, 16) : null;
}

function requireColor(
  node: Record<string, unknown>,
  key: string,
  problems: string[],
  prefix = '',
): number {
  const parsed = parseHexColor(node[key]);
  if (parsed !== null) return parsed;
  problems.push(`${prefix}${key}: missing or not a "#rrggbb" colour`);
  return 0x000000;
}

function readVec3(value: unknown): readonly [number, number, number] | null {
  if (!Array.isArray(value) || value.length !== 3) return null;
  const [x, y, z] = value as unknown[];
  if (typeof x !== 'number' || typeof y !== 'number' || typeof z !== 'number') return null;
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return null;
  return [x, y, z];
}

function requireVec3(
  node: Record<string, unknown>,
  prefix: string,
  problems: string[],
): readonly [number, number, number] {
  const parsed = readVec3(node['position']);
  if (parsed) return parsed;
  problems.push(`${prefix}position: missing or not a [x, y, z] number triple`);
  return [0, 0, 0];
}
