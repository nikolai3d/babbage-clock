/**
 * Looks: a named slot -> material-id mapping.
 *
 * A "look" is the whole point of the slot abstraction. Meshes reference slots
 * (`housing`, `ring`, `numerals`, …) and never a material, so re-skinning the
 * entire clock is a map from those ten names to material folder ids — no
 * geometry is rebuilt, no scene is reloaded, nothing is re-uploaded but the
 * textures themselves.
 *
 * Three.js-free on purpose: a look is data, exactly like a `SceneDefinition`.
 */

import { MATERIAL_SLOTS } from '../scene/types.js';
import type { MaterialBinding, MaterialSlot, MaterialSlotMap } from '../scene/types.js';

/** Slot -> material id. Every slot must be named, so a look is never partial. */
export type SlotMaterialIds = Readonly<Record<MaterialSlot, string>>;

export interface MaterialLook {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly slots: SlotMaterialIds;
}

/** Terse constructor for PBR bindings in scene files and looks. */
export function pbr(
  textureSet: string,
  extra: Omit<Extract<MaterialBinding, { kind: 'pbr' }>, 'kind' | 'textureSet'> = {},
): MaterialBinding {
  return { kind: 'pbr', textureSet, ...extra };
}

/** Fills every slot with one material id. */
export function uniformLook(materialId: string): SlotMaterialIds {
  return Object.fromEntries(MATERIAL_SLOTS.map((slot) => [slot, materialId])) as SlotMaterialIds;
}

/** Turns a look into the `MaterialSlotMap` a scene definition carries. */
export function lookToSlotMap(look: MaterialLook): MaterialSlotMap {
  return Object.fromEntries(
    MATERIAL_SLOTS.map((slot) => [slot, pbr(look.slots[slot])]),
  ) as MaterialSlotMap;
}

/**
 * The looks offered in the settings panel.
 *
 * `uv-grid` is a diagnostic rather than a style: it puts a numbered checker on
 * every part, which is how the numeral UVs were verified (see
 * `docs/materials.md`). It is kept in the shipped list deliberately — a UV
 * regression on a new generator is then one click away from being visible.
 */
export const MATERIAL_LOOKS: readonly MaterialLook[] = [
  {
    id: 'blued-steel',
    name: 'Blued steel',
    description: 'Every part in the blued-steel set — separate roughness/metal/AO maps.',
    slots: uniformLook('blued-steel'),
  },
  {
    id: 'uv-grid',
    name: 'UV grid (diagnostic)',
    description: 'Checker texture on every part, for inspecting UV layout and texel density.',
    slots: uniformLook('uv-grid'),
  },
];

export function resolveLook(id: string | null | undefined): MaterialLook | null {
  if (!id) return null;
  return MATERIAL_LOOKS.find((look) => look.id === id) ?? null;
}
