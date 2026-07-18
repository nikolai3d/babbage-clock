/**
 * The `material.json` contract.
 *
 * A material authored in Adobe Substance 3D Sampler arrives here as a folder of
 * baked textures plus this manifest. Nothing in this module imports three.js:
 * parsing, defaulting and validation are plain data work, so the whole contract
 * is unit-tested in a Node environment with no WebGL context — the same rule
 * `src/scene/` and `src/time/` follow.
 *
 * Two decisions are deliberately taken away from the manifest author:
 *
 * 1. **Colour space is per channel and is decided here**, not declared in the
 *    manifest. Base colour and emissive are sRGB; every other map is linear
 *    data. Letting an artist state it is the single most common way a PBR
 *    pipeline ships subtly wrong (double-gamma'd albedo, washed-out roughness).
 * 2. **Channel packing is fixed by the glTF metallic-roughness convention.** An
 *    ORM map is occlusion in R, roughness in G, metalness in B — which is what
 *    Sampler's glTF export writes and what three.js samples by default.
 *
 * See `docs/materials.md` for the schema in full and the exact Sampler export
 * settings that produce a compatible folder.
 */

/** Every texture channel a material folder may supply. */
export const MAP_CHANNELS = [
  'baseColor',
  'normal',
  'orm',
  'roughness',
  'metalness',
  'ao',
  'height',
  'emissive',
] as const;

export type MapChannel = (typeof MAP_CHANNELS)[number];

/**
 * Alternative spellings accepted for a channel key.
 *
 * Sampler's export templates and the wider PBR world disagree about naming, and
 * an artist should not have to rename keys to match ours. Anything not listed
 * here is a typo and is reported as one.
 */
const CHANNEL_ALIASES: Readonly<Record<string, MapChannel>> = {
  basecolor: 'baseColor',
  base_color: 'baseColor',
  albedo: 'baseColor',
  diffuse: 'baseColor',
  color: 'baseColor',
  normalmap: 'normal',
  normalgl: 'normal',
  normaldx: 'normal',
  metallic: 'metalness',
  metallicroughness: 'orm',
  occlusionroughnessmetallic: 'orm',
  arm: 'orm',
  ambientocclusion: 'ao',
  occlusion: 'ao',
  displacement: 'height',
  emission: 'emissive',
};

/** How a texture's values are encoded. `linear` means "raw data, do not decode". */
export type TextureColorSpace = 'srgb' | 'linear';

/**
 * The colour space a channel is *always* read in.
 *
 * This is the contract, not a default: a manifest cannot override it.
 */
export function colorSpaceForChannel(channel: MapChannel): TextureColorSpace {
  return channel === 'baseColor' || channel === 'emissive' ? 'srgb' : 'linear';
}

/** Normal maps come in two mutually inverted flavours; we render OpenGL (Y+). */
export type NormalConvention = 'opengl' | 'directx';

/** One texture channel resolved to files. */
export interface MapSource {
  readonly channel: MapChannel;
  /** Uncompressed source (PNG/JPG), relative to the material folder. */
  readonly file: string;
  /** Optional KTX2/BasisU alternative, preferred where the transcoder runs. */
  readonly ktx2?: string;
  /** Decided by {@link colorSpaceForChannel}; echoed here for the loader. */
  readonly colorSpace: TextureColorSpace;
}

export interface NormalSettings {
  /** `directx` sources are flipped on load; see `docs/materials.md`. */
  readonly convention: NormalConvention;
  /** Multiplier on the normal perturbation. 1 is the authored strength. */
  readonly scale: number;
}

/**
 * Values used wherever a map is absent.
 *
 * A material with no roughness map is not an error: it is a uniformly rough
 * material, and this is where it says how rough.
 */
export interface MaterialScalars {
  /** Multiplied with the base colour map, or used alone when there is none. */
  readonly baseColor: number;
  readonly metalness: number;
  readonly roughness: number;
  readonly emissive: number;
  readonly emissiveIntensity: number;
  /** Strength of the occlusion map. Ignored when no AO/ORM map is present. */
  readonly aoIntensity: number;
  /**
   * Height-map displacement in metres. Defaults to 0, and at 0 the height map
   * is not even fetched: these are low-poly procedural meshes with nothing to
   * displace, so paying for the download would buy nothing.
   */
  readonly displacementScale: number;
  readonly displacementBias: number;
}

/**
 * Optional `MeshPhysicalMaterial` extras.
 *
 * Sampler can author lacquered and brushed looks that plain metallic-roughness
 * cannot express. Each key here maps 1:1 onto the three.js property of the same
 * name; anything omitted is left at the three.js default.
 */
export interface PhysicalExtras {
  readonly clearcoat?: number;
  readonly clearcoatRoughness?: number;
  readonly anisotropy?: number;
  readonly anisotropyRotation?: number;
  readonly sheen?: number;
  readonly sheenRoughness?: number;
  readonly sheenColor?: number;
  readonly ior?: number;
  readonly specularIntensity?: number;
  readonly iridescence?: number;
}

const PHYSICAL_KEYS = [
  'clearcoat',
  'clearcoatRoughness',
  'anisotropy',
  'anisotropyRotation',
  'sheen',
  'sheenRoughness',
  'sheenColor',
  'ior',
  'specularIntensity',
  'iridescence',
] as const;

/** Extras that are colours rather than scalars, so they parse as hex. */
const PHYSICAL_COLOR_KEYS = new Set<string>(['sheenColor']);

/** A parsed, fully defaulted material definition. */
export interface MaterialManifest {
  /** Folder name; also the id a scene's `textureSet` refers to. */
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly maps: Readonly<Partial<Record<MapChannel, MapSource>>>;
  readonly normal: NormalSettings;
  /** Texture repeat, in the surface units documented in `docs/materials.md`. */
  readonly tiling: readonly [number, number];
  readonly offset: readonly [number, number];
  /** UV rotation in radians. */
  readonly rotation: number;
  readonly scalars: MaterialScalars;
  readonly physical: PhysicalExtras;
}

/** The default texture edge length a dropped-in folder should be capped at. */
export const DEFAULT_MAX_TEXTURE_SIZE = 2048;

export const DEFAULT_SCALARS: MaterialScalars = {
  baseColor: 0xcccccc,
  metalness: 0,
  roughness: 1,
  emissive: 0x000000,
  emissiveIntensity: 1,
  aoIntensity: 1,
  displacementScale: 0,
  displacementBias: 0,
};

/** Thrown with every problem in a manifest listed at once. */
export class MaterialManifestError extends Error {
  readonly problems: readonly string[];

  constructor(id: string, problems: readonly string[]) {
    super(`Invalid material manifest "${id}":\n  - ${problems.join('\n  - ')}`);
    this.name = 'MaterialManifestError';
    this.problems = problems;
  }
}

type Json = Record<string, unknown>;

function isRecord(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Accepts `"#b87333"`, `"b87333"` or `0xb87333`.
 *
 * Hex strings are what an artist reads off a colour picker; numbers are what a
 * scene file already uses. Both land on the same integer.
 */
export function parseColor(value: unknown, where: string, problems: string[]): number | null {
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value < 0 || value > 0xffffff) {
      problems.push(`${where} must be a colour in 0x000000…0xffffff, got ${value}`);
      return null;
    }
    return Math.round(value);
  }
  if (typeof value === 'string') {
    const hex = value.trim().replace(/^#/, '');
    if (!/^[0-9a-fA-F]{6}$/.test(hex)) {
      problems.push(`${where} must be a 6-digit hex colour like "#b87333", got "${value}"`);
      return null;
    }
    return Number.parseInt(hex, 16);
  }
  problems.push(`${where} must be a hex colour string or a number`);
  return null;
}

function parseNumber(
  value: unknown,
  where: string,
  problems: string[],
  range?: { min?: number; max?: number },
): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    problems.push(`${where} must be a finite number`);
    return null;
  }
  if (range?.min !== undefined && value < range.min) {
    problems.push(`${where} must be >= ${range.min}, got ${value}`);
    return null;
  }
  if (range?.max !== undefined && value > range.max) {
    problems.push(`${where} must be <= ${range.max}, got ${value}`);
    return null;
  }
  return value;
}

function parseVec2(
  value: unknown,
  where: string,
  problems: string[],
  fallback: readonly [number, number],
): readonly [number, number] {
  if (value === undefined) return fallback;
  if (typeof value === 'number') {
    const single = parseNumber(value, where, problems);
    return single === null ? fallback : [single, single];
  }
  if (!Array.isArray(value) || value.length !== 2) {
    problems.push(`${where} must be a number or a [u, v] pair`);
    return fallback;
  }
  const u = parseNumber(value[0], `${where}[0]`, problems);
  const v = parseNumber(value[1], `${where}[1]`, problems);
  return u === null || v === null ? fallback : [u, v];
}

/** Normalises a channel key, or reports it as unknown. */
function resolveChannel(key: string, problems: string[]): MapChannel | null {
  const direct = MAP_CHANNELS.find((channel) => channel === key);
  if (direct) return direct;

  const alias = CHANNEL_ALIASES[key.toLowerCase().replace(/[\s-]/g, '')];
  if (alias) return alias;

  problems.push(
    `unknown map channel "${key}"; expected one of ${MAP_CHANNELS.join(', ')} ` +
      '(common Sampler spellings such as "basecolor" and "metallic" are also accepted)',
  );
  return null;
}

function parseMapEntry(channel: MapChannel, value: unknown, problems: string[]): MapSource | null {
  const where = `maps.${channel}`;
  const colorSpace = colorSpaceForChannel(channel);

  if (typeof value === 'string') {
    if (value.trim() === '') {
      problems.push(`${where} is an empty filename`);
      return null;
    }
    return { channel, file: value.trim(), colorSpace };
  }

  if (!isRecord(value)) {
    problems.push(`${where} must be a filename or { "file": …, "ktx2": … }`);
    return null;
  }

  const file = value['file'];
  if (typeof file !== 'string' || file.trim() === '') {
    problems.push(`${where}.file must be a filename`);
    return null;
  }

  const ktx2 = value['ktx2'];
  if (ktx2 !== undefined && (typeof ktx2 !== 'string' || ktx2.trim() === '')) {
    problems.push(`${where}.ktx2 must be a filename when present`);
    return null;
  }

  return {
    channel,
    file: file.trim(),
    colorSpace,
    ...(typeof ktx2 === 'string' ? { ktx2: ktx2.trim() } : {}),
  };
}

function parseScalars(raw: unknown, problems: string[]): MaterialScalars {
  if (raw === undefined) return DEFAULT_SCALARS;
  if (!isRecord(raw)) {
    problems.push('scalars must be an object');
    return DEFAULT_SCALARS;
  }

  const colorOf = (key: 'baseColor' | 'emissive'): number => {
    if (raw[key] === undefined) return DEFAULT_SCALARS[key];
    return parseColor(raw[key], `scalars.${key}`, problems) ?? DEFAULT_SCALARS[key];
  };

  const numberOf = (
    key: Exclude<keyof MaterialScalars, 'baseColor' | 'emissive'>,
    range?: { min?: number; max?: number },
  ): number => {
    if (raw[key] === undefined) return DEFAULT_SCALARS[key];
    return parseNumber(raw[key], `scalars.${key}`, problems, range) ?? DEFAULT_SCALARS[key];
  };

  const unknown = Object.keys(raw).filter((key) => !(key in DEFAULT_SCALARS));
  for (const key of unknown) problems.push(`unknown scalar "${key}"`);

  return {
    baseColor: colorOf('baseColor'),
    emissive: colorOf('emissive'),
    metalness: numberOf('metalness', { min: 0, max: 1 }),
    roughness: numberOf('roughness', { min: 0, max: 1 }),
    emissiveIntensity: numberOf('emissiveIntensity', { min: 0 }),
    aoIntensity: numberOf('aoIntensity', { min: 0 }),
    displacementScale: numberOf('displacementScale'),
    displacementBias: numberOf('displacementBias'),
  };
}

function parsePhysical(raw: unknown, problems: string[]): PhysicalExtras {
  if (raw === undefined) return {};
  if (!isRecord(raw)) {
    problems.push('physical must be an object');
    return {};
  }

  const extras: PhysicalExtras = {};
  for (const [key, value] of Object.entries(raw)) {
    const known = PHYSICAL_KEYS.find((candidate) => candidate === key);
    if (!known) {
      problems.push(`unknown physical property "${key}"; supported: ${PHYSICAL_KEYS.join(', ')}`);
      continue;
    }
    const parsed = PHYSICAL_COLOR_KEYS.has(known)
      ? parseColor(value, `physical.${known}`, problems)
      : parseNumber(value, `physical.${known}`, problems, { min: 0 });
    if (parsed !== null) (extras as Record<string, number>)[known] = parsed;
  }
  return extras;
}

function parseNormal(raw: unknown, problems: string[]): NormalSettings {
  const fallback: NormalSettings = { convention: 'opengl', scale: 1 };
  if (raw === undefined) return fallback;
  if (!isRecord(raw)) {
    problems.push('normal must be an object');
    return fallback;
  }

  let convention: NormalConvention = 'opengl';
  const declared = raw['convention'];
  if (declared !== undefined) {
    if (declared === 'opengl' || declared === 'directx') convention = declared;
    else problems.push('normal.convention must be "opengl" or "directx"');
  }

  const scale =
    raw['scale'] === undefined ? 1 : (parseNumber(raw['scale'], 'normal.scale', problems) ?? 1);

  return { convention, scale };
}

/**
 * Parses and validates a `material.json`, reporting every problem at once.
 *
 * `id` is the folder name. It wins over any `name` in the file, so a material
 * can always be found by the path it was dropped at.
 */
export function parseMaterialManifest(raw: unknown, id: string): MaterialManifest {
  const problems: string[] = [];

  if (!isRecord(raw)) {
    throw new MaterialManifestError(id, ['manifest must be a JSON object']);
  }

  const known = new Set([
    '$schema',
    'name',
    'description',
    'maps',
    'normal',
    'tiling',
    'offset',
    'rotation',
    'scalars',
    'physical',
  ]);
  for (const key of Object.keys(raw)) {
    if (!known.has(key)) problems.push(`unknown manifest key "${key}"`);
  }

  const maps: Partial<Record<MapChannel, MapSource>> = {};
  const rawMaps = raw['maps'];
  if (rawMaps !== undefined) {
    if (!isRecord(rawMaps)) {
      problems.push('maps must be an object of channel -> filename');
    } else {
      for (const [key, value] of Object.entries(rawMaps)) {
        const channel = resolveChannel(key, problems);
        if (!channel) continue;
        if (maps[channel]) {
          problems.push(`map channel "${channel}" is declared twice`);
          continue;
        }
        const entry = parseMapEntry(channel, value, problems);
        if (entry) maps[channel] = entry;
      }
    }
  }

  const tiling = parseVec2(raw['tiling'], 'tiling', problems, [1, 1]);
  if (tiling[0] === 0 || tiling[1] === 0) problems.push('tiling must be non-zero');

  const name = typeof raw['name'] === 'string' && raw['name'].trim() !== '' ? raw['name'] : id;
  const description = typeof raw['description'] === 'string' ? raw['description'] : '';

  const manifest: MaterialManifest = {
    id,
    name,
    description,
    maps,
    normal: parseNormal(raw['normal'], problems),
    tiling,
    offset: parseVec2(raw['offset'], 'offset', problems, [0, 0]),
    rotation:
      raw['rotation'] === undefined ? 0 : (parseNumber(raw['rotation'], 'rotation', problems) ?? 0),
    scalars: parseScalars(raw['scalars'], problems),
    physical: parsePhysical(raw['physical'], problems),
  };

  if (problems.length > 0) throw new MaterialManifestError(id, problems);
  return manifest;
}

/**
 * Which channel actually supplies a given three.js map slot.
 *
 * A separate map always wins over the packed one, so an artist who exports ORM
 * *and* a hand-tweaked roughness gets the tweak. This is the only place that
 * decision is made.
 */
export function sourceForSlot(
  manifest: MaterialManifest,
  slot: 'roughness' | 'metalness' | 'ao',
): MapSource | undefined {
  return manifest.maps[slot] ?? manifest.maps.orm;
}

/** True when the material has any texture at all to load. */
export function hasTextures(manifest: MaterialManifest): boolean {
  return Object.keys(manifest.maps).length > 0;
}

/**
 * The files a manifest actually needs, deduplicated.
 *
 * An ORM map referenced from three slots is one download, and a height map is
 * skipped entirely unless the manifest asks for displacement — see
 * {@link MaterialScalars.displacementScale}.
 */
export function requiredMaps(manifest: MaterialManifest): readonly MapSource[] {
  const wanted: MapSource[] = [];
  const seen = new Set<string>();

  for (const channel of MAP_CHANNELS) {
    const source = manifest.maps[channel];
    if (!source) continue;
    if (channel === 'height' && manifest.scalars.displacementScale === 0) continue;
    if (seen.has(source.file)) continue;
    seen.add(source.file);
    wanted.push(source);
  }

  return wanted;
}
