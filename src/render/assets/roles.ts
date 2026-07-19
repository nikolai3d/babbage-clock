/**
 * The authored-part vocabulary and its mapping onto material slots.
 *
 * An authored `.glb` names each mesh after the *role* it plays; the loader looks
 * a role up here to find the transform slot it fills (in `ClockSceneView`) and
 * the material slot it binds. This is the single source of truth for the
 * role/slot table written out in `docs/authored-geometry.md`; keep the two in
 * step.
 *
 * Pure — no three.js — so it unit-tests without a WebGL context, same as the
 * geometry maths it sits beside.
 */

import type { MaterialSlot } from '../../scene/types.js';

/**
 * Every fixed role an authored part may take. `env-*` set-dressing is open-ended
 * and handled by prefix rather than being enumerated here.
 */
export const PART_ROLES = [
  'gearA',
  'gearB',
  'gearC',
  'gearD',
  'escape-wheel',
  'balance',
  'balance-cock',
  'ring-body',
  'numerals',
  'case-shell',
  'bezel',
  'lid',
  'hinge',
  'shackle',
  'stud',
  'boss',
  'arbor',
  'gear-pin',
  'detent-lever',
  'table',
] as const;

export type FixedPartRole = (typeof PART_ROLES)[number];
/** A fixed role, or an open-ended `env-<name>` set-dressing role. */
export type PartRole = FixedPartRole | `env-${string}`;

/**
 * Role -> material slot. Mirrors the table in `docs/authored-geometry.md` and
 * reuses the fixed `MATERIAL_SLOTS`; `env-*` falls through to `materialSlotForRole`.
 */
const FIXED_ROLE_SLOT: Record<FixedPartRole, MaterialSlot> = {
  'case-shell': 'housing',
  boss: 'housing',
  bezel: 'bezel',
  stud: 'bezel',
  balance: 'bezel',
  lid: 'frame',
  hinge: 'frame',
  shackle: 'frame',
  'balance-cock': 'frame',
  'ring-body': 'ring',
  numerals: 'numerals',
  gearA: 'gearA',
  gearB: 'gearB',
  gearC: 'gearC',
  gearD: 'gearD',
  'escape-wheel': 'gearD',
  arbor: 'arbor',
  'gear-pin': 'arbor',
  'detent-lever': 'arbor',
  table: 'housing',
};

function isFixedPartRole(name: string): name is FixedPartRole {
  return (PART_ROLES as readonly string[]).includes(name);
}

/**
 * The role an object name denotes, or null if it names nothing the engine knows.
 *
 * Blender appends `.001`, `.002` … to duplicate names; those are stripped so a
 * stray duplicate still resolves to its role. A name the engine does not
 * recognise returns null and the part is ignored — a scene never fails to load
 * because a model carries an extra mesh.
 */
export function roleForObjectName(name: string): PartRole | null {
  const base = name.replace(/\.\d+$/, '');
  if (isFixedPartRole(base)) return base;
  if (/^env-[\w-]+$/.test(base)) return base as PartRole;
  return null;
}

/** The material slot a role binds. */
export function materialSlotForRole(role: PartRole): MaterialSlot {
  if (role.startsWith('env-')) return 'frame';
  return FIXED_ROLE_SLOT[role as FixedPartRole];
}
