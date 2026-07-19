import * as THREE from 'three';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AssetLibrary } from './assetLibrary.js';
import { AssetRegistry, type LoadedModel } from './assetRegistry.js';
import { materialSlotForRole, roleForObjectName, type PartRole } from './roles.js';
import type { AssetSpec } from '../../scene/types.js';

/**
 * The loader is unit-tested through an injected model loader, never a real
 * `.glb`: `GLTFLoader` needs a browser-ish environment, and the point of the
 * seam is that the resolution and degrade logic is checkable in plain Node.
 * Real decode is covered by the e2e layer.
 */

function makeModel(roles: readonly PartRole[]): {
  model: LoadedModel;
  geometries: Map<PartRole, THREE.BufferGeometry>;
} {
  const geometries = new Map<PartRole, THREE.BufferGeometry>();
  for (const role of roles) {
    const geometry = new THREE.BoxGeometry(1, 1, 1);
    geometry.name = role;
    geometries.set(role, geometry);
  }
  return { model: { parts: geometries }, geometries };
}

/** A registry whose loader resolves to a fixed set of roles after a microtask. */
function registryWith(roles: readonly PartRole[]): {
  registry: AssetRegistry;
  geometries: Map<PartRole, THREE.BufferGeometry>;
  calls: () => number;
} {
  const { model, geometries } = makeModel(roles);
  let calls = 0;
  const registry = new AssetRegistry({
    loadModel: () => {
      calls += 1;
      return Promise.resolve(model);
    },
  });
  return { registry, geometries, calls: () => calls };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('roles', () => {
  it('maps each role onto its documented material slot', () => {
    expect(materialSlotForRole('case-shell')).toBe('housing');
    expect(materialSlotForRole('stud')).toBe('bezel');
    expect(materialSlotForRole('balance')).toBe('bezel');
    expect(materialSlotForRole('shackle')).toBe('frame');
    expect(materialSlotForRole('ring-body')).toBe('ring');
    expect(materialSlotForRole('numerals')).toBe('numerals');
    expect(materialSlotForRole('gearC')).toBe('gearC');
    expect(materialSlotForRole('escape-wheel')).toBe('gearD');
    expect(materialSlotForRole('detent-lever')).toBe('arbor');
    expect(materialSlotForRole('env-backwall')).toBe('frame');
  });

  it('resolves object names to roles, stripping Blender duplicate suffixes', () => {
    expect(roleForObjectName('gearB')).toBe('gearB');
    expect(roleForObjectName('gearB.001')).toBe('gearB');
    expect(roleForObjectName('env-plinth')).toBe('env-plinth');
    expect(roleForObjectName('Cube')).toBeNull();
    expect(roleForObjectName('lamp')).toBeNull();
  });
});

describe('AssetLibrary', () => {
  it('has no parts and is not busy when the scene declares no model', async () => {
    const library = new AssetLibrary(undefined);
    expect(library.hasSpec).toBe(false);
    expect(library.busy).toBe(false);
    expect(library.part('gearB')).toBeNull();
    await expect(library.ready()).resolves.toBeUndefined();
    library.dispose();
  });

  it('returns null until loaded, then the authored geometry for a known role', async () => {
    const { registry } = registryWith(['gearB', 'ring-body']);
    const library = new AssetLibrary({ source: 'model.glb' }, { registry });

    // Synchronous first build (as ClockSceneView does): nothing yet -> generator.
    expect(library.busy).toBe(true);
    expect(library.part('gearB')).toBeNull();

    await library.ready();

    expect(library.busy).toBe(false);
    expect(library.part('gearB')).toBeInstanceOf(THREE.BufferGeometry);
    expect(library.part('ring-body')).toBeInstanceOf(THREE.BufferGeometry);
    // A role the model does not carry still falls back.
    expect(library.part('numerals')).toBeNull();
    expect(new Set(library.availableRoles())).toEqual(new Set(['gearB', 'ring-body']));
    library.dispose();
  });

  it('degrades to null (never throws) when the model fails to load', async () => {
    const registry = new AssetRegistry({
      loadModel: () => Promise.reject(new Error('404')),
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const library = new AssetLibrary({ source: 'missing.glb' }, { registry });

    await expect(library.ready()).resolves.toBeUndefined();
    expect(library.part('gearB')).toBeNull();
    expect(library.busy).toBe(false);
    expect(warn).toHaveBeenCalledOnce();
    library.dispose();
  });
});

describe('AssetRegistry reference counting', () => {
  it('decodes a source once and shares it across libraries', async () => {
    const { registry, calls } = registryWith(['gearB']);
    const spec: AssetSpec = { source: 'model.glb' };

    const a = new AssetLibrary(spec, { registry });
    const b = new AssetLibrary(spec, { registry });
    await Promise.all([a.ready(), b.ready()]);

    expect(calls()).toBe(1);
    expect(a.part('gearB')).toBe(b.part('gearB'));
    a.dispose();
    b.dispose();
  });

  it('disposes a model only when the last reference is released', async () => {
    const { registry, geometries } = registryWith(['gearB']);
    const geometry = geometries.get('gearB')!;
    const dispose = vi.spyOn(geometry, 'dispose');
    const spec: AssetSpec = { source: 'model.glb' };

    const a = new AssetLibrary(spec, { registry });
    const b = new AssetLibrary(spec, { registry });
    await Promise.all([a.ready(), b.ready()]);

    a.dispose();
    expect(dispose).not.toHaveBeenCalled();
    expect(registry.stats().models).toBe(1);

    b.dispose();
    expect(dispose).toHaveBeenCalledOnce();
    expect(registry.stats().models).toBe(0);
  });
});
