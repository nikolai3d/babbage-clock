import { MATERIAL_SLOTS, type SceneDefinition } from './types.js';

/**
 * Structural checks that catch the mistakes a bead author is most likely to
 * make when adding a new scene. Pure and three.js-free, so it runs in unit
 * tests and at registry construction time.
 */
export function validateSceneDefinition(scene: SceneDefinition): string[] {
  const errors: string[] = [];
  const where = `scene "${scene.id || '(missing id)'}"`;

  if (!scene.id) errors.push('scene is missing an id');
  if (!scene.name) errors.push(`${where}: missing name`);

  const { rings } = scene;
  if (!Number.isInteger(rings.count) || rings.count < 1) {
    errors.push(`${where}: rings.count must be a positive integer, got ${rings.count}`);
  }
  if (rings.radius <= 0) errors.push(`${where}: rings.radius must be > 0`);
  if (rings.thickness <= 0) errors.push(`${where}: rings.thickness must be > 0`);
  if (rings.radialSegments < 3) errors.push(`${where}: rings.radialSegments must be >= 3`);
  if (rings.spacing < rings.thickness) {
    errors.push(
      `${where}: rings.spacing (${rings.spacing}) is smaller than rings.thickness ` +
        `(${rings.thickness}); adjacent rings would intersect`,
    );
  }

  for (const slot of [rings.slot, rings.markSlot]) {
    if (!MATERIAL_SLOTS.includes(slot)) {
      errors.push(`${where}: rings reference unknown material slot "${slot}"`);
    }
  }

  for (const separator of rings.separators ?? []) {
    if (
      !Number.isInteger(separator.afterRing) ||
      separator.afterRing < 0 ||
      separator.afterRing > rings.count
    ) {
      errors.push(
        `${where}: ring separator afterRing must be an integer in [0, ${rings.count}], ` +
          `got ${separator.afterRing}`,
      );
    }
  }

  const gearIds = new Set<string>();
  for (const gear of scene.gears) {
    if (gearIds.has(gear.id)) errors.push(`${where}: duplicate gear id "${gear.id}"`);
    gearIds.add(gear.id);
    if (gear.radius <= 0) errors.push(`${where}: gear "${gear.id}" radius must be > 0`);
    if (gear.teeth < 3) errors.push(`${where}: gear "${gear.id}" needs at least 3 teeth`);
    if (!MATERIAL_SLOTS.includes(gear.slot)) {
      errors.push(`${where}: gear "${gear.id}" references unknown material slot "${gear.slot}"`);
    }
    const [ax, ay, az] = gear.axis;
    if (ax === 0 && ay === 0 && az === 0) {
      errors.push(`${where}: gear "${gear.id}" has a zero-length rotation axis`);
    }
    if (gear.phase !== undefined && !Number.isFinite(gear.phase)) {
      errors.push(`${where}: gear "${gear.id}" phase must be a finite number`);
    }
  }

  for (const slot of MATERIAL_SLOTS) {
    if (!scene.materials[slot]) errors.push(`${where}: material slot "${slot}" is unbound`);
  }

  if (scene.assets !== undefined) {
    if (typeof scene.assets.source !== 'string' || scene.assets.source.trim() === '') {
      errors.push(`${where}: assets.source must be a non-empty string`);
    }
  }

  const { camera } = scene;
  if (camera.near <= 0) errors.push(`${where}: camera.near must be > 0`);
  if (camera.far <= camera.near) errors.push(`${where}: camera.far must exceed camera.near`);
  if (camera.minDistance <= 0) errors.push(`${where}: camera.minDistance must be > 0`);
  if (camera.maxDistance <= camera.minDistance) {
    errors.push(`${where}: camera.maxDistance must exceed camera.minDistance`);
  }
  if (camera.minPolarAngle < 0 || camera.maxPolarAngle > Math.PI) {
    errors.push(`${where}: camera polar angles must lie within [0, PI]`);
  }
  if (camera.minPolarAngle >= camera.maxPolarAngle) {
    errors.push(`${where}: camera.minPolarAngle must be less than camera.maxPolarAngle`);
  }

  return errors;
}

/** Throws with every problem listed at once, rather than failing on the first. */
export function assertValidScene(scene: SceneDefinition): void {
  const errors = validateSceneDefinition(scene);
  if (errors.length > 0) {
    throw new Error(`Invalid scene definition:\n  - ${errors.join('\n  - ')}`);
  }
}
