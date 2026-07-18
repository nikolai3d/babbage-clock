import type { PlaceholderMaterialBinding } from './types.js';

/** Terse constructor for untextured material bindings in scene definitions. */
export function placeholder(
  color: number,
  metalness: number,
  roughness: number,
  extra: Omit<PlaceholderMaterialBinding, 'kind' | 'color' | 'metalness' | 'roughness'> = {},
): PlaceholderMaterialBinding {
  return { kind: 'placeholder', color, metalness, roughness, ...extra };
}
