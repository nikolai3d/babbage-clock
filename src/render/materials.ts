import * as THREE from 'three';
import { MATERIAL_SLOTS } from '../scene/types.js';
import { requiredMaps, sourceForSlot } from '../materials/manifest.js';
import { sharedMaterialRegistry } from './materialRegistry.js';
import type { MaterialManifest } from '../materials/manifest.js';
import type { MaterialRegistry, TextureTransform } from './materialRegistry.js';
import type {
  MaterialBinding,
  MaterialSlot,
  MaterialSlotMap,
  PbrMaterialBinding,
} from '../scene/types.js';

/**
 * Turns a scene's material slot map into concrete three.js materials.
 *
 * The load-bearing property is that **the material instance for a slot never
 * changes**. Meshes are handed `library.get('ring')` once, at build time, and
 * keep that reference for as long as they exist; swapping a slot's material at
 * runtime rewrites that instance in place rather than replacing it. That is
 * what makes a hot swap free of a scene rebuild, and it is why the swap cannot
 * flash: the surface that is already on screen keeps its current maps until the
 * replacements have finished decoding, and only then does everything change at
 * once.
 *
 * One library instance per active scene; `dispose()` releases every material it
 * created and gives back every texture reference it holds. The textures
 * themselves live in the {@link MaterialRegistry}, which is shared across scene
 * switches so switching back and forth does not re-download anything.
 */
export class MaterialLibrary {
  private readonly slots = new Map<MaterialSlot, SlotMaterial>();
  private disposed = false;

  constructor(slots: MaterialSlotMap, registry: MaterialRegistry = sharedMaterialRegistry()) {
    for (const slot of MATERIAL_SLOTS) {
      const material = new SlotMaterial(slot, registry);
      material.apply(slots[slot]);
      this.slots.set(slot, material);
    }
  }

  get(slot: MaterialSlot): THREE.MeshPhysicalMaterial {
    const entry = this.slots.get(slot);
    if (!entry) throw new Error(`Material slot "${slot}" was not built`);
    return entry.material;
  }

  /** The binding currently in force for a slot. Surfaced to the test API. */
  bindingFor(slot: MaterialSlot): MaterialBinding {
    const entry = this.slots.get(slot);
    if (!entry) throw new Error(`Material slot "${slot}" was not built`);
    return entry.binding;
  }

  /**
   * Rebinds one or more slots without touching the scene graph.
   *
   * This is the whole hot-swap path: nothing is rebuilt, no mesh is reassigned,
   * no geometry is re-uploaded. Only the material instances change, and only
   * once their textures are in hand.
   */
  apply(bindings: Partial<Record<MaterialSlot, MaterialBinding>>): void {
    if (this.disposed) return;
    for (const slot of MATERIAL_SLOTS) {
      const binding = bindings[slot];
      if (binding) this.slots.get(slot)?.apply(binding);
    }
  }

  /**
   * Resolves when nothing is still loading.
   *
   * Loops because finishing one apply can start another (a look switched while
   * the first was still in flight), and the caller means "settled", not "the
   * first batch finished".
   */
  async ready(): Promise<void> {
    for (let guard = 0; guard < 32; guard += 1) {
      const pending = [...this.slots.values()]
        .map((slot) => slot.settled())
        .filter((entry): entry is Promise<void> => entry !== null);
      if (pending.length === 0) return;
      await Promise.all(pending);
    }
  }

  dispose(): void {
    this.disposed = true;
    for (const entry of this.slots.values()) entry.dispose();
    this.slots.clear();
  }
}

/** Shown while a material's manifest is still being fetched. */
const NEUTRAL_COLOR = 0x9a9a9a;

/**
 * Three.js defaults for the `MeshPhysicalMaterial` extras.
 *
 * Reset on every commit so a look that declared clearcoat cannot leave it
 * behind on the look that follows it.
 */
const PHYSICAL_DEFAULTS = {
  clearcoat: 0,
  clearcoatRoughness: 0,
  anisotropy: 0,
  anisotropyRotation: 0,
  sheen: 0,
  sheenRoughness: 1,
  sheenColor: 0xffffff,
  ior: 1.5,
  specularIntensity: 1,
  iridescence: 0,
} as const;

/**
 * One slot's material and the texture references behind it.
 *
 * Every asynchronous apply is stamped with a generation. A load that finishes
 * after a newer binding has been requested releases what it acquired and
 * returns without touching the material — otherwise a viewer who clicks through
 * three looks quickly would end up on whichever one happened to decode last.
 */
class SlotMaterial {
  readonly material: THREE.MeshPhysicalMaterial;
  binding: MaterialBinding;

  private readonly registry: MaterialRegistry;
  private keys: string[] = [];
  private generation = 0;
  private inFlight: Promise<void> | null = null;
  private warned = false;

  constructor(slot: MaterialSlot, registry: MaterialRegistry) {
    this.registry = registry;
    this.material = new THREE.MeshPhysicalMaterial({ color: NEUTRAL_COLOR });
    this.material.name = `slot:${slot}`;
    this.binding = { kind: 'placeholder', color: NEUTRAL_COLOR, metalness: 0, roughness: 1 };
  }

  apply(binding: MaterialBinding): void {
    this.binding = binding;
    const generation = (this.generation += 1);

    if (binding.kind === 'placeholder') {
      this.commit(null, binding);
      this.inFlight = null;
      return;
    }

    // A slot with nothing on it yet gets a plausible neutral immediately, so
    // the first frame is never black while the folder is being fetched.
    if (this.keys.length === 0) {
      this.material.color.setHex(NEUTRAL_COLOR);
      this.material.metalness = binding.metalness ?? 0.6;
      this.material.roughness = binding.roughness ?? 0.5;
    }

    // Cleared when this particular apply settles, whether it succeeded or not.
    // Clearing it unconditionally inside `load` would let a superseded apply
    // report the slot as settled while a newer one was still in flight; leaving
    // it set after a failure would make `ready()` spin on an already-resolved
    // promise.
    const settling: Promise<void> = this.load(binding, generation)
      .catch((error: unknown) => {
        if (generation !== this.generation) return;
        if (!this.warned) {
          this.warned = true;
          console.warn(
            `[materials] could not load material "${binding.textureSet}" for ` +
              `${this.material.name}; showing a neutral surface`,
            error,
          );
        }
      })
      .finally(() => {
        if (this.inFlight === settling) this.inFlight = null;
      });
    this.inFlight = settling;
  }

  /** The in-flight apply, or null when this slot is settled. */
  settled(): Promise<void> | null {
    return this.inFlight;
  }

  dispose(): void {
    this.generation += 1;
    this.releaseAll();
    this.material.dispose();
  }

  private async load(binding: PbrMaterialBinding, generation: number): Promise<void> {
    const manifest = await this.registry.manifest(binding.textureSet);
    if (generation !== this.generation) return;

    const transform = transformFor(manifest, binding);
    const acquired = await Promise.all(
      requiredMaps(manifest).map(async (source) => ({
        channel: source.channel,
        ...(await this.registry.acquire(binding.textureSet, source, transform)),
      })),
    );

    if (generation !== this.generation) {
      for (const entry of acquired) this.registry.release(entry.key);
      return;
    }

    const textures = new Map<string, THREE.Texture>();
    for (const entry of acquired) textures.set(entry.channel, entry.texture);

    // Old references are only given back once the replacements are committed,
    // which is what keeps the swap from flashing through an untextured frame.
    const previous = this.keys;
    this.keys = acquired.map((entry) => entry.key);
    this.commit({ manifest, textures }, binding);
    for (const key of previous) this.registry.release(key);
  }

  private releaseAll(): void {
    for (const key of this.keys) this.registry.release(key);
    this.keys = [];
  }

  /**
   * Writes the whole material state at once.
   *
   * `loaded` is null for a placeholder binding or for a PBR binding whose
   * folder could not be read; either way the material ends up fully defined
   * rather than half-updated.
   */
  private commit(
    loaded: { manifest: MaterialManifest; textures: Map<string, THREE.Texture> } | null,
    binding: MaterialBinding,
  ): void {
    const material = this.material;

    if (!loaded) {
      this.releaseAll();
      clearMaps(material);
      resetPhysical(material);

      if (binding.kind === 'placeholder') {
        material.color.setHex(binding.color);
        material.metalness = binding.metalness;
        material.roughness = binding.roughness;
        material.emissive.setHex(binding.emissive ?? 0x000000);
        material.emissiveIntensity = binding.emissiveIntensity ?? 1;
      }
      material.needsUpdate = true;
      return;
    }

    const { manifest, textures } = loaded;
    const { scalars } = manifest;

    const baseColorMap = textures.get('baseColor') ?? null;
    const normalMap = textures.get('normal') ?? null;
    const emissiveMap = textures.get('emissive') ?? null;
    const heightMap = textures.get('height') ?? null;
    const roughnessMap = mapFor(manifest, textures, 'roughness');
    const metalnessMap = mapFor(manifest, textures, 'metalness');
    const aoMap = mapFor(manifest, textures, 'ao');

    material.map = baseColorMap;
    material.normalMap = normalMap;
    material.roughnessMap = roughnessMap;
    material.metalnessMap = metalnessMap;
    material.aoMap = aoMap;
    material.emissiveMap = emissiveMap;
    material.displacementMap = scalars.displacementScale === 0 ? null : heightMap;

    // A baked map already *is* the final albedo, so the tint has to be white or
    // the material is multiplied by its own colour twice. Same reasoning for
    // roughness and metalness: with a map present the scalar becomes a
    // multiplier, and the scene's override — documented as exactly that — rides
    // on top of it.
    material.color.setHex(baseColorMap ? 0xffffff : scalars.baseColor);
    material.roughness = pickScalar(binding.kind === 'pbr' ? binding.roughness : undefined, {
      hasMap: roughnessMap !== null,
      authored: scalars.roughness,
    });
    material.metalness = pickScalar(binding.kind === 'pbr' ? binding.metalness : undefined, {
      hasMap: metalnessMap !== null,
      authored: scalars.metalness,
    });

    material.emissive.setHex(emissiveMap ? 0xffffff : scalars.emissive);
    material.emissiveIntensity = scalars.emissiveIntensity;
    material.aoMapIntensity = scalars.aoIntensity;
    material.displacementScale = scalars.displacementScale;
    material.displacementBias = scalars.displacementBias;

    // A DirectX-convention normal map has its green channel inverted relative
    // to OpenGL. Flipping the sign of `normalScale.y` is the fix, and it costs
    // nothing: no image is rewritten, and an artist who ticked the wrong export
    // template only has to say so in the manifest.
    const normalScale = manifest.normal.scale;
    material.normalScale.set(
      normalScale,
      manifest.normal.convention === 'directx' ? -normalScale : normalScale,
    );

    resetPhysical(material);
    applyPhysical(material, manifest);

    material.needsUpdate = true;
  }
}

/** A scene's per-slot tiling overrides the manifest's; otherwise the manifest wins. */
function transformFor(manifest: MaterialManifest, binding: PbrMaterialBinding): TextureTransform {
  const tiling = binding.tiling ?? manifest.tiling;
  return {
    repeat: [tiling[0] ?? 1, tiling[1] ?? 1],
    offset: manifest.offset,
    rotation: manifest.rotation,
  };
}

function mapFor(
  manifest: MaterialManifest,
  textures: Map<string, THREE.Texture>,
  slot: 'roughness' | 'metalness' | 'ao',
): THREE.Texture | null {
  const source = sourceForSlot(manifest, slot);
  if (!source) return null;
  return textures.get(source.channel) ?? null;
}

/**
 * A scene override is a multiplier over an authored map and a replacement when
 * there is none — which is what `PbrMaterialBinding` documents it as.
 */
function pickScalar(
  override: number | undefined,
  { hasMap, authored }: { hasMap: boolean; authored: number },
): number {
  if (hasMap) return override ?? 1;
  return override ?? authored;
}

function clearMaps(material: THREE.MeshPhysicalMaterial): void {
  material.map = null;
  material.normalMap = null;
  material.roughnessMap = null;
  material.metalnessMap = null;
  material.aoMap = null;
  material.emissiveMap = null;
  material.displacementMap = null;
  material.displacementScale = 0;
  material.normalScale.set(1, 1);
  material.aoMapIntensity = 1;
}

function resetPhysical(material: THREE.MeshPhysicalMaterial): void {
  material.clearcoat = PHYSICAL_DEFAULTS.clearcoat;
  material.clearcoatRoughness = PHYSICAL_DEFAULTS.clearcoatRoughness;
  material.anisotropy = PHYSICAL_DEFAULTS.anisotropy;
  material.anisotropyRotation = PHYSICAL_DEFAULTS.anisotropyRotation;
  material.sheen = PHYSICAL_DEFAULTS.sheen;
  material.sheenRoughness = PHYSICAL_DEFAULTS.sheenRoughness;
  material.sheenColor.setHex(PHYSICAL_DEFAULTS.sheenColor);
  material.ior = PHYSICAL_DEFAULTS.ior;
  material.specularIntensity = PHYSICAL_DEFAULTS.specularIntensity;
  material.iridescence = PHYSICAL_DEFAULTS.iridescence;
}

function applyPhysical(material: THREE.MeshPhysicalMaterial, manifest: MaterialManifest): void {
  const extras = manifest.physical;
  if (extras.clearcoat !== undefined) material.clearcoat = extras.clearcoat;
  if (extras.clearcoatRoughness !== undefined) {
    material.clearcoatRoughness = extras.clearcoatRoughness;
  }
  if (extras.anisotropy !== undefined) material.anisotropy = extras.anisotropy;
  if (extras.anisotropyRotation !== undefined) {
    material.anisotropyRotation = extras.anisotropyRotation;
  }
  if (extras.sheen !== undefined) material.sheen = extras.sheen;
  if (extras.sheenRoughness !== undefined) material.sheenRoughness = extras.sheenRoughness;
  if (extras.sheenColor !== undefined) material.sheenColor.setHex(extras.sheenColor);
  if (extras.ior !== undefined) material.ior = extras.ior;
  if (extras.specularIntensity !== undefined) {
    material.specularIntensity = extras.specularIntensity;
  }
  if (extras.iridescence !== undefined) material.iridescence = extras.iridescence;
}
