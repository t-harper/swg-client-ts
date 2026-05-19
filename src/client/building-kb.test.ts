/**
 * Tests for `BuildingKBImpl` — the portal-layout + (Track B) template-info
 * cache.
 *
 * Mirrors `string-kb.test.ts` in structure. All cases inject a fake
 * `loadPortalLayout` via `BuildingKBOptions.loadPortalLayout` so the suite
 * is filesystem-free. The real on-disk path is exercised indirectly through
 * the fixture-based `portal-layout-reader.test.ts`.
 *
 * The Track B placeholder behavior of `templateInfoFor` is covered too,
 * with an explicit reminder comment for the swg-dev agent that lands
 * Track B — that test will need to be deleted (or rewritten) when the
 * real implementation arrives.
 */

import { describe, expect, it, vi } from 'vitest';
import type { PortalLayout } from '../iff/portal-layout-reader.js';
import { BuildingKBImpl, type BuildingTemplateInfo } from './building-kb.js';

/**
 * Tiny fake `PortalLayout`. We don't need a realistic graph — every
 * BuildingKB test cares only about the loader being called the right
 * number of times with the right arguments and the cache surfacing the
 * same value object. Picking minimal data also makes intent clear.
 */
function fakeLayout(sourceName: string): PortalLayout {
  return {
    sourceName,
    version: '0003',
    geometries: [
      {
        vertices: [
          { x: 0, y: 0, z: 0 },
          { x: 1, y: 0, z: 0 },
          { x: 1, y: 1, z: 0 },
          { x: 0, y: 1, z: 0 },
        ],
        center: { x: 0.5, y: 0.5, z: 0 },
      },
    ],
    cells: [
      { index: 0, name: 'r0', portals: [] },
      { index: 1, name: 'room1', portals: [] },
    ],
  };
}

describe('BuildingKBImpl — portalLayoutFor: laziness + caching', () => {
  it('does NOT call loadPortalLayout until portalLayoutFor is invoked', () => {
    const loadPortalLayout = vi.fn(async (name: string) => fakeLayout(name));
    new BuildingKBImpl({ loadPortalLayout });
    expect(loadPortalLayout).not.toHaveBeenCalled();
  });

  it('caches per filename — repeated calls fire loadPortalLayout exactly once', async () => {
    const loadPortalLayout = vi.fn(async (name: string) => fakeLayout(name));
    const kb = new BuildingKBImpl({ loadPortalLayout });
    const a = await kb.portalLayoutFor('appearance/thm_tato_cantina.pob');
    const b = await kb.portalLayoutFor('appearance/thm_tato_cantina.pob');
    const c = await kb.portalLayoutFor('appearance/thm_tato_cantina.pob');
    expect(loadPortalLayout).toHaveBeenCalledTimes(1);
    expect(loadPortalLayout).toHaveBeenCalledWith('appearance/thm_tato_cantina.pob');
    expect(a).toBe(b);
    expect(b).toBe(c);
    expect(kb.size()).toBe(1);
  });

  it('coalesces concurrent portalLayoutFor calls for the same file into one in-flight promise', async () => {
    const loadPortalLayout = vi.fn(async (name: string) => {
      // Force a microtask hop so the second caller observes the in-flight
      // promise rather than racing to completion.
      await new Promise((r) => setTimeout(r, 0));
      return fakeLayout(name);
    });
    const kb = new BuildingKBImpl({ loadPortalLayout });
    const [a, b, c] = await Promise.all([
      kb.portalLayoutFor('appearance/x.pob'),
      kb.portalLayoutFor('appearance/x.pob'),
      kb.portalLayoutFor('appearance/x.pob'),
    ]);
    expect(loadPortalLayout).toHaveBeenCalledTimes(1);
    expect(a).toBe(b);
    expect(b).toBe(c);
  });

  it('caches different filenames separately', async () => {
    const loadPortalLayout = vi.fn(async (name: string) => fakeLayout(name));
    const kb = new BuildingKBImpl({ loadPortalLayout });
    const cantina = await kb.portalLayoutFor('appearance/cantina.pob');
    const hospital = await kb.portalLayoutFor('appearance/hospital.pob');
    expect(loadPortalLayout).toHaveBeenCalledTimes(2);
    expect(cantina.sourceName).toBe('appearance/cantina.pob');
    expect(hospital.sourceName).toBe('appearance/hospital.pob');
    expect(kb.size()).toBe(2);
  });
});

describe('BuildingKBImpl — portalLayoutFor: failure handling', () => {
  it('does NOT cache the failure when loadPortalLayout throws; next call retries', async () => {
    let attempt = 0;
    const loadPortalLayout = vi.fn(async (name: string) => {
      attempt += 1;
      if (attempt === 1) throw new Error('asset not found');
      return fakeLayout(name);
    });
    const kb = new BuildingKBImpl({ loadPortalLayout });

    await expect(kb.portalLayoutFor('appearance/x.pob')).rejects.toThrow(/asset not found/);
    // Failure was evicted — cache stays empty.
    expect(kb.size()).toBe(0);

    // Retry succeeds and caches.
    const second = await kb.portalLayoutFor('appearance/x.pob');
    expect(second.sourceName).toBe('appearance/x.pob');
    expect(loadPortalLayout).toHaveBeenCalledTimes(2);
    expect(kb.size()).toBe(1);
  });

  it('does NOT cache the failure when loadPortalLayout returns a rejecting promise', async () => {
    let attempt = 0;
    const loadPortalLayout = vi.fn((name: string) => {
      attempt += 1;
      if (attempt === 1) return Promise.reject(new Error('async fail'));
      return Promise.resolve(fakeLayout(name));
    });
    const kb = new BuildingKBImpl({ loadPortalLayout });
    await expect(kb.portalLayoutFor('appearance/x.pob')).rejects.toThrow(/async fail/);
    expect(kb.size()).toBe(0);
    const second = await kb.portalLayoutFor('appearance/x.pob');
    expect(second).toBeDefined();
    expect(kb.size()).toBe(1);
  });

  it('a concurrent failure rejects all waiters without poisoning the cache', async () => {
    const loadPortalLayout = vi.fn(async (_name: string) => {
      await new Promise((r) => setTimeout(r, 0));
      throw new Error('boom');
    });
    const kb = new BuildingKBImpl({ loadPortalLayout });
    const results = await Promise.allSettled([
      kb.portalLayoutFor('appearance/x.pob'),
      kb.portalLayoutFor('appearance/x.pob'),
      kb.portalLayoutFor('appearance/x.pob'),
    ]);
    // All three waiters share the same in-flight load and all three reject.
    expect(loadPortalLayout).toHaveBeenCalledTimes(1);
    for (const r of results) {
      expect(r.status).toBe('rejected');
      if (r.status === 'rejected') expect(String(r.reason)).toMatch(/boom/);
    }
    // Cache must be empty after the failure.
    expect(kb.size()).toBe(0);
  });
});

describe('BuildingKBImpl — evict + clear + size', () => {
  it('evict(filename) drops just that file; subsequent call reloads it', async () => {
    const loadPortalLayout = vi.fn(async (name: string) => fakeLayout(name));
    const kb = new BuildingKBImpl({ loadPortalLayout });
    await kb.portalLayoutFor('appearance/a.pob');
    await kb.portalLayoutFor('appearance/b.pob');
    expect(kb.size()).toBe(2);

    kb.evict('appearance/a.pob');
    expect(kb.size()).toBe(1);

    await kb.portalLayoutFor('appearance/a.pob');
    expect(loadPortalLayout).toHaveBeenCalledTimes(3); // 2 initial + 1 reload
    expect(kb.size()).toBe(2);
  });

  it('clear() drops every cached entry', async () => {
    const loadPortalLayout = vi.fn(async (name: string) => fakeLayout(name));
    const kb = new BuildingKBImpl({ loadPortalLayout });
    await kb.portalLayoutFor('appearance/a.pob');
    await kb.portalLayoutFor('appearance/b.pob');
    await kb.portalLayoutFor('appearance/c.pob');
    expect(kb.size()).toBe(3);
    kb.clear();
    expect(kb.size()).toBe(0);
  });
});

// ─── Track B placeholder ─────────────────────────────────────────────────
//
// `templateInfoFor` is implemented in Track B (the object-template
// extractor). Track A ships the interface + a sentinel error so the
// `BuildingKB` shape is final and Track A's downstream consumers can
// be wired up without waiting. The Track B agent MUST delete or
// rewrite this describe block when they land their implementation —
// it intentionally asserts the placeholder error so it fails loudly
// once Track B replaces the stub.

describe('BuildingKBImpl — templateInfoFor (Track B placeholder)', () => {
  it('throws the placeholder sentinel until Track B lands an implementation', async () => {
    const loadPortalLayout = vi.fn(async (name: string) => fakeLayout(name));
    const kb = new BuildingKBImpl({ loadPortalLayout });
    await expect(
      kb.templateInfoFor('object/building/tatooine/cantina_tatooine.iff'),
    ).rejects.toThrow(/Track B not yet landed/);
  });

  it('delegates to the loader and caches when one is provided (Track B integration shape)', async () => {
    // This shape — `BuildingKBOptions.loadBuildingTemplateInfo` — is the
    // contract Track B has to honor. Asserting it here pins the API so
    // Track B can't accidentally rename it.
    const loadBuildingTemplateInfo = vi.fn(
      async (name: string): Promise<BuildingTemplateInfo> => ({
        templateName: name,
        portalLayoutFilename: 'appearance/thm_tato_cantina.pob',
        appearanceFilename: 'appearance/cantina_tatooine.msh',
      }),
    );
    const kb = new BuildingKBImpl({
      loadPortalLayout: async (name) => fakeLayout(name),
      loadBuildingTemplateInfo,
    });
    const a = await kb.templateInfoFor('object/building/tatooine/cantina_tatooine.iff');
    const b = await kb.templateInfoFor('object/building/tatooine/cantina_tatooine.iff');
    expect(loadBuildingTemplateInfo).toHaveBeenCalledTimes(1);
    expect(a).toBe(b);
    expect(a.portalLayoutFilename).toBe('appearance/thm_tato_cantina.pob');
    expect(kb.size()).toBe(1);
  });
});
