import * as THREE from 'three';
import { MATERIAL_SLOTS } from '../scene/types.js';
import type { MaterialBinding, MaterialSlot, MaterialSlotMap } from '../scene/types.js';

/**
 * Turns a scene's material slot map into concrete three.js materials.
 *
 * One library instance per active scene; `dispose()` releases every material it
 * created. Scene switching constructs a new library and disposes the old one,
 * which is what keeps repeated switching from leaking GPU memory.
 */
export class MaterialLibrary {
  private readonly materials = new Map<MaterialSlot, THREE.MeshStandardMaterial>();

  constructor(slots: MaterialSlotMap) {
    for (const slot of MATERIAL_SLOTS) {
      const material = createMaterial(slots[slot]);
      material.name = `slot:${slot}`;
      this.materials.set(slot, material);
    }
  }

  get(slot: MaterialSlot): THREE.MeshStandardMaterial {
    const material = this.materials.get(slot);
    if (!material) throw new Error(`Material slot "${slot}" was not built`);
    return material;
  }

  dispose(): void {
    for (const material of this.materials.values()) material.dispose();
    this.materials.clear();
  }
}

/** Fallback appearance for PBR bindings until the texture-loading bead lands. */
const PBR_FALLBACK_COLOR = 0x9a9a9a;

function createMaterial(binding: MaterialBinding): THREE.MeshStandardMaterial {
  if (binding.kind === 'pbr') {
    console.warn(
      `[materials] PBR binding "${binding.textureSet}" is not loadable yet; ` +
        'using a neutral placeholder. Texture loading arrives in a later bead.',
    );
    return new THREE.MeshStandardMaterial({
      color: PBR_FALLBACK_COLOR,
      metalness: binding.metalness ?? 0.8,
      roughness: binding.roughness ?? 0.4,
    });
  }

  const material = new THREE.MeshStandardMaterial({
    color: binding.color,
    metalness: binding.metalness,
    roughness: binding.roughness,
  });

  if (binding.emissive !== undefined) {
    material.emissive = new THREE.Color(binding.emissive);
    material.emissiveIntensity = binding.emissiveIntensity ?? 1;
  }

  return material;
}
