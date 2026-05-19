/**
 * Tests for `BuildingKBImpl` — the portal-layout + template-info cache.
 *
 * Mirrors `string-kb.test.ts` in structure. All cases inject fake loaders
 * via `BuildingKBOptions.{loadPortalLayout, loadBuildingTemplateInfo}` so
 * the suite is filesystem-free. The real on-disk path is exercised
 * indirectly through the fixture-based `portal-layout-reader.test.ts` and
 * `object-template-reader.test.ts`.
 */

import { describe, expect, it, vi } from 'vitest';
import type { CrcStringTable } from '../iff/crc-string-table-reader.js';
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

// ─── templateInfoFor: laziness + caching ─────────────────────────────────

describe('BuildingKBImpl — templateInfoFor: laziness + caching', () => {
  // Tiny fake `BuildingTemplateInfo` — minimal data; the cache tests only
  // care that the same value object surfaces across calls.
  function fakeInfo(templateName: string): BuildingTemplateInfo {
    return {
      templateName,
      portalLayoutFilename: 'appearance/thm_tato_cantina.pob',
      appearanceFilename: 'appearance/cantina_tatooine.msh',
    };
  }

  it('does NOT call loadBuildingTemplateInfo until templateInfoFor is invoked', () => {
    const loadBuildingTemplateInfo = vi.fn(async (name: string) => fakeInfo(name));
    new BuildingKBImpl({
      loadPortalLayout: async (n) => fakeLayout(n),
      loadBuildingTemplateInfo,
    });
    expect(loadBuildingTemplateInfo).not.toHaveBeenCalled();
  });

  it('caches per templateName — repeated calls fire the loader exactly once', async () => {
    const loadBuildingTemplateInfo = vi.fn(async (name: string) => fakeInfo(name));
    const kb = new BuildingKBImpl({
      loadPortalLayout: async (n) => fakeLayout(n),
      loadBuildingTemplateInfo,
    });
    const a = await kb.templateInfoFor('object/building/tatooine/shared_cantina_tatooine.iff');
    const b = await kb.templateInfoFor('object/building/tatooine/shared_cantina_tatooine.iff');
    const c = await kb.templateInfoFor('object/building/tatooine/shared_cantina_tatooine.iff');
    expect(loadBuildingTemplateInfo).toHaveBeenCalledTimes(1);
    expect(loadBuildingTemplateInfo).toHaveBeenCalledWith(
      'object/building/tatooine/shared_cantina_tatooine.iff',
    );
    expect(a).toBe(b);
    expect(b).toBe(c);
    expect(a.portalLayoutFilename).toBe('appearance/thm_tato_cantina.pob');
    expect(kb.size()).toBe(1);
  });

  it('coalesces concurrent templateInfoFor calls for the same template into one load', async () => {
    const loadBuildingTemplateInfo = vi.fn(async (name: string) => {
      // Force a microtask hop so the second + third callers observe the
      // in-flight promise rather than racing to completion.
      await new Promise((r) => setTimeout(r, 0));
      return fakeInfo(name);
    });
    const kb = new BuildingKBImpl({
      loadPortalLayout: async (n) => fakeLayout(n),
      loadBuildingTemplateInfo,
    });
    const [a, b, c] = await Promise.all([
      kb.templateInfoFor('object/x/shared_x.iff'),
      kb.templateInfoFor('object/x/shared_x.iff'),
      kb.templateInfoFor('object/x/shared_x.iff'),
    ]);
    expect(loadBuildingTemplateInfo).toHaveBeenCalledTimes(1);
    expect(a).toBe(b);
    expect(b).toBe(c);
  });

  it('caches different templateNames separately', async () => {
    const loadBuildingTemplateInfo = vi.fn(async (name: string) => fakeInfo(name));
    const kb = new BuildingKBImpl({
      loadPortalLayout: async (n) => fakeLayout(n),
      loadBuildingTemplateInfo,
    });
    const cantina = await kb.templateInfoFor(
      'object/building/tatooine/shared_cantina_tatooine.iff',
    );
    const hospital = await kb.templateInfoFor(
      'object/building/tatooine/shared_hospital_tatooine.iff',
    );
    expect(loadBuildingTemplateInfo).toHaveBeenCalledTimes(2);
    expect(cantina.templateName).toBe('object/building/tatooine/shared_cantina_tatooine.iff');
    expect(hospital.templateName).toBe('object/building/tatooine/shared_hospital_tatooine.iff');
    expect(kb.size()).toBe(2);
  });

  it('mixes portal-layout and template-info entries in the cache size', async () => {
    const kb = new BuildingKBImpl({
      loadPortalLayout: async (n) => fakeLayout(n),
      loadBuildingTemplateInfo: async (n) => fakeInfo(n),
    });
    await kb.portalLayoutFor('appearance/thm_tato_cantina.pob');
    await kb.templateInfoFor('object/building/tatooine/shared_cantina_tatooine.iff');
    expect(kb.size()).toBe(2);
  });
});

describe('BuildingKBImpl — templateInfoFor: failure handling', () => {
  function fakeInfo(templateName: string): BuildingTemplateInfo {
    return {
      templateName,
      portalLayoutFilename: 'appearance/x.pob',
      appearanceFilename: null,
    };
  }

  it('does NOT cache the failure when loadBuildingTemplateInfo throws; next call retries', async () => {
    let attempt = 0;
    const loadBuildingTemplateInfo = vi.fn(async (name: string) => {
      attempt += 1;
      if (attempt === 1) throw new Error('asset not found');
      return fakeInfo(name);
    });
    const kb = new BuildingKBImpl({
      loadPortalLayout: async (n) => fakeLayout(n),
      loadBuildingTemplateInfo,
    });

    await expect(kb.templateInfoFor('object/x/shared_x.iff')).rejects.toThrow(/asset not found/);
    // Failure was evicted — cache stays empty.
    expect(kb.size()).toBe(0);

    // Retry succeeds and caches.
    const second = await kb.templateInfoFor('object/x/shared_x.iff');
    expect(second.templateName).toBe('object/x/shared_x.iff');
    expect(loadBuildingTemplateInfo).toHaveBeenCalledTimes(2);
    expect(kb.size()).toBe(1);
  });

  it('a concurrent failure rejects all waiters without poisoning the cache', async () => {
    const loadBuildingTemplateInfo = vi.fn(async (_name: string) => {
      await new Promise((r) => setTimeout(r, 0));
      throw new Error('template parse failed');
    });
    const kb = new BuildingKBImpl({
      loadPortalLayout: async (n) => fakeLayout(n),
      loadBuildingTemplateInfo,
    });
    const results = await Promise.allSettled([
      kb.templateInfoFor('object/x/shared_x.iff'),
      kb.templateInfoFor('object/x/shared_x.iff'),
      kb.templateInfoFor('object/x/shared_x.iff'),
    ]);
    // All three waiters share the same in-flight load and all three reject.
    expect(loadBuildingTemplateInfo).toHaveBeenCalledTimes(1);
    for (const r of results) {
      expect(r.status).toBe('rejected');
      if (r.status === 'rejected') expect(String(r.reason)).toMatch(/template parse failed/);
    }
    // Cache must be empty after the failure.
    expect(kb.size()).toBe(0);
  });

  it('clear() drops both portal layouts AND template-info entries', async () => {
    const kb = new BuildingKBImpl({
      loadPortalLayout: async (n) => fakeLayout(n),
      loadBuildingTemplateInfo: async (n) => fakeInfo(n),
    });
    await kb.portalLayoutFor('appearance/a.pob');
    await kb.portalLayoutFor('appearance/b.pob');
    await kb.templateInfoFor('object/x/shared_a.iff');
    await kb.templateInfoFor('object/x/shared_b.iff');
    expect(kb.size()).toBe(4);
    kb.clear();
    expect(kb.size()).toBe(0);
  });
});

describe('BuildingKBImpl — default loaders (no overrides)', () => {
  it('templateInfoFor uses the on-disk loader when no override is supplied', () => {
    // Constructing without any opts must NOT throw — the default loader
    // chain is wired up and only invoked when `templateInfoFor` is called.
    // This is the load-bearing Track B contract change: prior behavior was
    // "throws sentinel error until Track B lands"; new behavior is "uses
    // `loadBuildingTemplateInfo` from `object-template-reader.ts` by default".
    const kb = new BuildingKBImpl();
    expect(kb.size()).toBe(0);
    // Don't actually call the loader — the asset-loader chain hits the
    // real filesystem / TRE archive, and this suite is filesystem-free.
    // The fact that construction succeeds is the assertion we need.
  });
});

// ─── templateNameForCrc: laziness + caching ──────────────────────────────

/**
 * Build a fake `CrcStringTable` from an `(crc, name)` map. The fake's
 * `lookup` returns the mapped name or `null`; `entries()` walks the map
 * in declaration order. Used by every `templateNameForCrc` test below.
 */
function fakeCrcTable(entries: { [crcHex: string]: string }): CrcStringTable {
  const m = new Map<number, string>();
  for (const [hex, name] of Object.entries(entries)) {
    m.set(Number.parseInt(hex, 16), name);
  }
  return {
    lookup(crc: number): string | null {
      return m.get(crc >>> 0) ?? null;
    },
    size(): number {
      return m.size;
    },
    *entries() {
      for (const [crc, name] of m.entries()) yield { crc, name };
    },
  };
}

describe('BuildingKBImpl — templateNameForCrc: laziness + caching', () => {
  it('does NOT call loadCrcStringTable until templateNameForCrc is invoked', () => {
    const loadCrcStringTable = vi.fn(async () => fakeCrcTable({}));
    new BuildingKBImpl({ loadCrcStringTable });
    expect(loadCrcStringTable).not.toHaveBeenCalled();
  });

  it('loads the table once and reuses it for every lookup', async () => {
    const loadCrcStringTable = vi.fn(async () =>
      fakeCrcTable({
        '0x3ff15d0a': 'object/building/tatooine/shared_cantina_tatooine.iff',
        '0xdeadbeef': 'object/building/test/shared_test.iff',
      }),
    );
    const kb = new BuildingKBImpl({ loadCrcStringTable });

    const cantina = await kb.templateNameForCrc(0x3ff15d0a);
    expect(cantina).toBe('object/building/tatooine/shared_cantina_tatooine.iff');

    const test = await kb.templateNameForCrc(0xdeadbeef);
    expect(test).toBe('object/building/test/shared_test.iff');

    // Unknown CRC returns null without re-loading.
    const missing = await kb.templateNameForCrc(0x12345678);
    expect(missing).toBeNull();

    expect(loadCrcStringTable).toHaveBeenCalledTimes(1);
  });

  it('coalesces concurrent templateNameForCrc calls into one load', async () => {
    const loadCrcStringTable = vi.fn(async () => {
      // Microtask hop so concurrent callers race to the same in-flight promise.
      await new Promise((r) => setTimeout(r, 0));
      return fakeCrcTable({ '0x3ff15d0a': 'foo/bar.iff' });
    });
    const kb = new BuildingKBImpl({ loadCrcStringTable });
    const [a, b, c] = await Promise.all([
      kb.templateNameForCrc(0x3ff15d0a),
      kb.templateNameForCrc(0x3ff15d0a),
      kb.templateNameForCrc(0x3ff15d0a),
    ]);
    expect(loadCrcStringTable).toHaveBeenCalledTimes(1);
    expect(a).toBe('foo/bar.iff');
    expect(b).toBe('foo/bar.iff');
    expect(c).toBe('foo/bar.iff');
  });

  it('handles high-bit-set CRCs (unsigned uint32)', async () => {
    // The cantina-like fixture but with a high-bit CRC. Verifies we don't
    // accidentally sign-extend somewhere in the lookup pipeline.
    const loadCrcStringTable = vi.fn(async () =>
      fakeCrcTable({ '0xffaabbcc': 'object/high_bit/shared.iff' }),
    );
    const kb = new BuildingKBImpl({ loadCrcStringTable });
    // Pass the signed-int form (negative when interpreted as int32) — the
    // method must still resolve it.
    expect(await kb.templateNameForCrc(0xffaabbcc | 0)).toBe('object/high_bit/shared.iff');
    expect(await kb.templateNameForCrc(0xffaabbcc)).toBe('object/high_bit/shared.iff');
  });

  it('size() reflects the loaded table once + portal/template entries', async () => {
    const loadCrcStringTable = vi.fn(async () => fakeCrcTable({ '0x1': 'a.iff' }));
    const kb = new BuildingKBImpl({
      loadPortalLayout: async (n) => fakeLayout(n),
      loadBuildingTemplateInfo: async (n) => ({
        templateName: n,
        portalLayoutFilename: null,
        appearanceFilename: null,
      }),
      loadCrcStringTable,
    });
    expect(kb.size()).toBe(0);
    await kb.templateNameForCrc(0x1);
    expect(kb.size()).toBe(1);
    await kb.portalLayoutFor('appearance/a.pob');
    expect(kb.size()).toBe(2);
    await kb.templateInfoFor('object/x/shared_x.iff');
    expect(kb.size()).toBe(3);
  });
});

describe('BuildingKBImpl — templateNameForCrc: failure handling', () => {
  it('returns null when the loader rejects, and the NEXT call retries the load', async () => {
    let attempt = 0;
    const loadCrcStringTable = vi.fn(async () => {
      attempt += 1;
      if (attempt === 1) throw new Error('asset not found');
      return fakeCrcTable({ '0x1': 'recovered.iff' });
    });
    const kb = new BuildingKBImpl({ loadCrcStringTable });

    // First attempt: loader rejects → method returns null.
    expect(await kb.templateNameForCrc(0x1)).toBeNull();
    // Cache must have evicted the failed promise so size is still 0.
    expect(kb.size()).toBe(0);

    // Second attempt: loader succeeds → method returns the mapped name.
    expect(await kb.templateNameForCrc(0x1)).toBe('recovered.iff');
    expect(loadCrcStringTable).toHaveBeenCalledTimes(2);
    expect(kb.size()).toBe(1);
  });

  it('returns null on an outright string rejection (not an Error instance)', async () => {
    const loadCrcStringTable = vi.fn((): Promise<CrcStringTable> => Promise.reject('boom'));
    const kb = new BuildingKBImpl({ loadCrcStringTable });
    expect(await kb.templateNameForCrc(0x1)).toBeNull();
    // Cache evicted, next call retries.
    expect(kb.size()).toBe(0);
  });

  it('clear() drops the loaded CRC table', async () => {
    const loadCrcStringTable = vi.fn(async () => fakeCrcTable({ '0x1': 'a.iff' }));
    const kb = new BuildingKBImpl({ loadCrcStringTable });
    await kb.templateNameForCrc(0x1);
    expect(kb.size()).toBe(1);
    kb.clear();
    expect(kb.size()).toBe(0);
    // Next call must reload.
    await kb.templateNameForCrc(0x1);
    expect(loadCrcStringTable).toHaveBeenCalledTimes(2);
  });
});
