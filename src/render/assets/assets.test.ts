import * as THREE from 'three';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AssetLibrary } from './assetLibrary.js';
import { AssetRegistry, type LoadedModel } from './assetRegistry.js';
import { materialSlotForRole, roleForObjectName, PART_ROLES, type PartRole } from './roles.js';
import type { AssetSpec, MaterialSlot } from '../../scene/types.js';

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
    expect(roleForObjectName('env-plinth.001')).toBe('env-plinth');
    expect(roleForObjectName('Cube')).toBeNull();
    expect(roleForObjectName('lamp')).toBeNull();
    expect(roleForObjectName('environment')).toBeNull();
  });

  /**
   * Every fixed role, cross-checked against the table in
   * `docs/authored-geometry.md` §3 — the two are meant to be kept in step, and
   * looping over `PART_ROLES` (rather than spot-checking a handful) is what
   * catches a typo in `FIXED_ROLE_SLOT` for an entry nobody happened to pick,
   * like `boss`, `lid`, `hinge`, `gearD`, `arbor`, `gear-pin` or `table`.
   */
  it('maps every fixed role onto its documented material slot', () => {
    const expected: Record<(typeof PART_ROLES)[number], MaterialSlot> = {
      gearA: 'gearA',
      gearB: 'gearB',
      gearC: 'gearC',
      gearD: 'gearD',
      'escape-wheel': 'gearD',
      balance: 'bezel',
      'balance-cock': 'frame',
      'ring-body': 'ring',
      numerals: 'numerals',
      'case-shell': 'housing',
      bezel: 'bezel',
      lid: 'frame',
      hinge: 'frame',
      shackle: 'frame',
      stud: 'bezel',
      boss: 'housing',
      arbor: 'arbor',
      'gear-pin': 'arbor',
      'detent-lever': 'arbor',
      table: 'housing',
      casing: 'casing',
    };

    for (const role of PART_ROLES) {
      expect(materialSlotForRole(role)).toBe(expected[role]);
    }
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

  it('serves authored geometry synchronously from a warm cache', async () => {
    const { registry } = registryWith(['gearB']);
    const spec: AssetSpec = { source: 'model.glb' };

    const first = new AssetLibrary(spec, { registry });
    await first.ready();
    expect(first.part('gearB')).toBeInstanceOf(THREE.BufferGeometry);

    // A second library for the same, already-resolved source: no await before
    // asserting — this is `AssetRegistry.peek`'s synchronous fast path, not
    // the acquire promise settling.
    const second = new AssetLibrary(spec, { registry });
    expect(second.busy).toBe(false);
    expect(second.part('gearB')).toBe(first.part('gearB'));

    first.dispose();
    second.dispose();
  });

  it('is idempotent: a second dispose does not give back a reference it never held', async () => {
    const { registry, geometries } = registryWith(['gearB']);
    const geometry = geometries.get('gearB')!;
    const dispose = vi.spyOn(geometry, 'dispose');
    const spec: AssetSpec = { source: 'model.glb' };

    const library = new AssetLibrary(spec, { registry });
    const keepAlive = new AssetLibrary(spec, { registry });
    await Promise.all([library.ready(), keepAlive.ready()]);

    library.dispose();
    library.dispose();
    // A double-decrement here would drop the shared model's refcount to zero
    // and dispose geometry `keepAlive` is still using.
    expect(dispose).not.toHaveBeenCalled();
    expect(registry.stats().models).toBe(1);

    keepAlive.dispose();
    expect(dispose).toHaveBeenCalledOnce();
    expect(registry.stats().models).toBe(0);
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

  it('disposes a model released while its load is still in flight (registry path)', async () => {
    const { model, geometries } = makeModel(['gearB']);
    const geometry = geometries.get('gearB')!;
    const dispose = vi.spyOn(geometry, 'dispose');
    let deliver: ((model: LoadedModel) => void) | null = null;
    const registry = new AssetRegistry({
      loadModel: () =>
        new Promise((resolve) => {
          deliver = resolve;
        }),
    });

    // Mirrors the mid-flight-dispose pattern in `render/ibl/library.test.ts`:
    // let go of the only reference before the decode settles, then let it
    // settle anyway, and check nothing was orphaned.
    const pending = registry.acquire('model.glb');
    registry.release('model.glb');
    deliver!(model);

    await pending;
    expect(dispose).toHaveBeenCalledOnce();
    expect(registry.stats().models).toBe(0);
  });

  it('disposes a model whose AssetLibrary was disposed while it was still loading', async () => {
    const { model, geometries } = makeModel(['gearB']);
    const geometry = geometries.get('gearB')!;
    const dispose = vi.spyOn(geometry, 'dispose');
    let deliver: ((model: LoadedModel) => void) | null = null;
    const registry = new AssetRegistry({
      loadModel: () =>
        new Promise((resolve) => {
          deliver = resolve;
        }),
    });
    const library = new AssetLibrary({ source: 'model.glb' }, { registry });

    library.dispose();
    deliver!(model);
    await library.ready();

    expect(dispose).toHaveBeenCalledOnce();
    expect(registry.stats().models).toBe(0);
    // The load settling after dispose must not publish parts onto a disposed
    // library: `this.parts` would point at geometry the registry has already
    // freed. This pins the `if (!this.disposed)` guard — without it `part()`
    // would hand back a disposed buffer here.
    expect(library.part('gearB')).toBeNull();
  });
});

describe('AssetRegistry', () => {
  it('forwards load progress to the onProgress option with the source', async () => {
    const onProgress = vi.fn();
    const { model } = makeModel(['gearB']);
    const registry = new AssetRegistry({
      onProgress,
      loadModel: (_url, reportProgress) => {
        reportProgress?.(50, 100);
        return Promise.resolve(model);
      },
    });

    await registry.acquire('model.glb');

    expect(onProgress).toHaveBeenCalledWith('model.glb', 50, 100);
  });

  it('disposes every geometry it holds', async () => {
    const { registry, geometries } = registryWith(['gearB', 'ring-body']);
    const disposeSpies = [...geometries.values()].map((geometry) => vi.spyOn(geometry, 'dispose'));

    await registry.acquire('model.glb');
    registry.dispose();

    for (const spy of disposeSpies) expect(spy).toHaveBeenCalledOnce();
    expect(registry.stats().models).toBe(0);
  });
});
