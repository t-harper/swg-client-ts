import { describe, expect, it, vi } from 'vitest';

import type {
  ProceduralTerrainAppearance,
  ProceduralTerrainTemplate,
} from '../terrain/sim/index.js';
import { KnowledgeImpl, TerrainKBImpl } from './knowledge.js';
import { createTerrainView } from './terrain-view.js';

// ──────────────────────────────────────────────────────────────────────
// Test fixtures — minimal fakes that satisfy the public contract of the
// terrain types without doing any real I/O or generator work.
// ──────────────────────────────────────────────────────────────────────

function makeFakeAppearance(seed = 0): ProceduralTerrainAppearance {
  return {
    getHeight: (x: number, z: number): number => seed + x + z,
  } as unknown as ProceduralTerrainAppearance;
}

function makeFakeTemplate(name: string): ProceduralTerrainTemplate {
  return { sourceName: name } as unknown as ProceduralTerrainTemplate;
}

// ──────────────────────────────────────────────────────────────────────
// TerrainKBImpl — process-wide per-planet appearance cache.
// ──────────────────────────────────────────────────────────────────────

describe('TerrainKBImpl', () => {
  it('does NOT call the loader until appearanceFor() is requested', () => {
    const loadTemplate = vi.fn(async () => makeFakeTemplate('naboo'));
    new TerrainKBImpl({ loadTemplate });
    expect(loadTemplate).not.toHaveBeenCalled();
  });

  it('lazy-loads on first appearanceFor() call', async () => {
    const loadTemplate = vi.fn(async (planet: string) => makeFakeTemplate(planet));
    const buildAppearance = vi.fn(() => makeFakeAppearance(5));
    const kb = new TerrainKBImpl({ loadTemplate, buildAppearance });
    const appearance = await kb.appearanceFor('naboo');
    expect(loadTemplate).toHaveBeenCalledWith('naboo');
    expect(buildAppearance).toHaveBeenCalledTimes(1);
    expect(appearance.getHeight(2, 3)).toBe(10);
  });

  it('caches per-planet — repeat calls return the same appearance instance', async () => {
    const loadTemplate = vi.fn(async (planet: string) => makeFakeTemplate(planet));
    const kb = new TerrainKBImpl({
      loadTemplate,
      buildAppearance: () => makeFakeAppearance(),
    });
    const a = await kb.appearanceFor('naboo');
    const b = await kb.appearanceFor('naboo');
    expect(a).toBe(b);
    expect(loadTemplate).toHaveBeenCalledTimes(1);
  });

  it('coalesces concurrent loads for the same planet into one in-flight promise', async () => {
    const loadTemplate = vi.fn(async (planet: string) => {
      await new Promise((r) => setTimeout(r, 0));
      return makeFakeTemplate(planet);
    });
    const kb = new TerrainKBImpl({
      loadTemplate,
      buildAppearance: () => makeFakeAppearance(),
    });
    const [a, b, c] = await Promise.all([
      kb.appearanceFor('naboo'),
      kb.appearanceFor('naboo'),
      kb.appearanceFor('naboo'),
    ]);
    expect(a).toBe(b);
    expect(b).toBe(c);
    expect(loadTemplate).toHaveBeenCalledTimes(1);
  });

  it('keeps separate cache entries per planet', async () => {
    const loadTemplate = vi.fn(async (planet: string) => makeFakeTemplate(planet));
    const kb = new TerrainKBImpl({
      loadTemplate,
      buildAppearance: (t) => makeFakeAppearance(t.sourceName === 'naboo' ? 1 : 2),
    });
    const naboo = await kb.appearanceFor('naboo');
    const rori = await kb.appearanceFor('rori');
    expect(naboo).not.toBe(rori);
    expect(naboo.getHeight(0, 0)).toBe(1);
    expect(rori.getHeight(0, 0)).toBe(2);
    expect(loadTemplate).toHaveBeenCalledTimes(2);
    expect(kb.size()).toBe(2);
  });

  it('does NOT cache failed loads — a retry triggers a fresh load attempt', async () => {
    let attempt = 0;
    const loadTemplate = vi.fn(async (planet: string) => {
      attempt++;
      if (attempt === 1) throw new Error(`asset missing for ${planet}`);
      return makeFakeTemplate(planet);
    });
    const kb = new TerrainKBImpl({
      loadTemplate,
      buildAppearance: () => makeFakeAppearance(99),
    });
    await expect(kb.appearanceFor('naboo')).rejects.toThrow('asset missing for naboo');
    expect(kb.size()).toBe(0);
    const ok = await kb.appearanceFor('naboo');
    expect(ok.getHeight(0, 0)).toBe(99);
    expect(loadTemplate).toHaveBeenCalledTimes(2);
    expect(kb.size()).toBe(1);
  });

  it('evict(planet) drops a single entry', async () => {
    const loadTemplate = vi.fn(async (planet: string) => makeFakeTemplate(planet));
    const kb = new TerrainKBImpl({
      loadTemplate,
      buildAppearance: () => makeFakeAppearance(),
    });
    await kb.appearanceFor('naboo');
    await kb.appearanceFor('rori');
    expect(kb.size()).toBe(2);
    kb.evict('naboo');
    expect(kb.size()).toBe(1);
    // Re-loading naboo triggers a fresh load.
    await kb.appearanceFor('naboo');
    expect(loadTemplate).toHaveBeenCalledTimes(3);
  });

  it('clear() drops every cached planet', async () => {
    const loadTemplate = vi.fn(async (planet: string) => makeFakeTemplate(planet));
    const kb = new TerrainKBImpl({
      loadTemplate,
      buildAppearance: () => makeFakeAppearance(),
    });
    await kb.appearanceFor('naboo');
    await kb.appearanceFor('rori');
    await kb.appearanceFor('tatooine');
    expect(kb.size()).toBe(3);
    kb.clear();
    expect(kb.size()).toBe(0);
  });

  it('defaults to the real loader + ProceduralTerrainAppearance when no overrides supplied', () => {
    // Smoke test: construction without overrides must not throw. We don't
    // actually call appearanceFor() here because that would hit the file
    // system; the test exists to lock the default-argument behavior.
    const kb = new TerrainKBImpl();
    expect(kb.size()).toBe(0);
  });
});

// ──────────────────────────────────────────────────────────────────────
// Headline guarantee: TWO TerrainViews over ONE Knowledge share the cache.
//
// This is the whole reason `Knowledge` exists. In a 30-client Fleet on
// Naboo, every script's `ctx.terrain.appearance()` must resolve to the
// same `ProceduralTerrainAppearance` instance — same chunk cache, same
// ~5 MB allocation, one `.trn` parse. If this assertion fails, the
// architecture is broken.
// ──────────────────────────────────────────────────────────────────────

describe('Shared knowledge guarantee (the headline)', () => {
  it('two TerrainViews over one Knowledge share the per-planet appearance — loader fires exactly once', async () => {
    const loadTemplate = vi.fn(async (planet: string) => makeFakeTemplate(planet));
    const buildAppearance = vi.fn(() => makeFakeAppearance(42));
    const knowledge = new KnowledgeImpl({ terrain: { loadTemplate, buildAppearance } });

    let planetA = 'naboo';
    let planetB = 'naboo';
    const viewA = createTerrainView({ knowledge, getCurrentPlanet: () => planetA });
    const viewB = createTerrainView({ knowledge, getCurrentPlanet: () => planetB });

    const [appearanceA, appearanceB] = await Promise.all([viewA.appearance(), viewB.appearance()]);

    expect(appearanceA).toBe(appearanceB);
    expect(loadTemplate).toHaveBeenCalledTimes(1);
    expect(buildAppearance).toHaveBeenCalledTimes(1);

    // Touching a third time from either view still doesn't re-load.
    await viewA.getHeight(1, 2);
    await viewB.getHeight(3, 4);
    expect(loadTemplate).toHaveBeenCalledTimes(1);

    // Suppress unused-locals warnings — we keep `planetA` / `planetB` as
    // `let` to mirror real per-script planet getters that change at zone-in.
    planetA = 'naboo';
    planetB = 'naboo';
  });
});

// ──────────────────────────────────────────────────────────────────────
// KnowledgeImpl.preload — fires loads in parallel for every supplied planet.
// ──────────────────────────────────────────────────────────────────────

describe('KnowledgeImpl.preload', () => {
  it('preload({ planets }) loads each planet exactly once, in parallel', async () => {
    // Track peak in-flight count to prove parallelism: if `preload` awaited
    // each load sequentially, peak would be 1; if it dispatches all at once,
    // peak reaches the planet count before any resolves.
    let inFlight = 0;
    let peak = 0;
    const loadTemplate = vi.fn(async (planet: string) => {
      inFlight++;
      if (inFlight > peak) peak = inFlight;
      // Hold loads in flight for a microtask so a second load can overlap.
      await new Promise((r) => setTimeout(r, 0));
      inFlight--;
      return makeFakeTemplate(planet);
    });
    const knowledge = new KnowledgeImpl({
      terrain: { loadTemplate, buildAppearance: () => makeFakeAppearance() },
    });

    await knowledge.preload({ planets: ['naboo', 'tatooine'] });
    expect(loadTemplate).toHaveBeenCalledTimes(2);
    expect(loadTemplate).toHaveBeenCalledWith('naboo');
    expect(loadTemplate).toHaveBeenCalledWith('tatooine');
    expect(peak).toBe(2);
    expect(knowledge.terrain.size()).toBe(2);
  });

  it('preload() with no planets is a no-op (no load fires)', async () => {
    const loadTemplate = vi.fn(async (planet: string) => makeFakeTemplate(planet));
    const knowledge = new KnowledgeImpl({
      terrain: { loadTemplate, buildAppearance: () => makeFakeAppearance() },
    });
    await knowledge.preload();
    expect(loadTemplate).not.toHaveBeenCalled();
  });

  it('preload({ planets: [] }) is a no-op', async () => {
    const loadTemplate = vi.fn(async (planet: string) => makeFakeTemplate(planet));
    const knowledge = new KnowledgeImpl({
      terrain: { loadTemplate, buildAppearance: () => makeFakeAppearance() },
    });
    await knowledge.preload({ planets: [] });
    expect(loadTemplate).not.toHaveBeenCalled();
  });

  it('preload({ planets }) reuses entries on a follow-up appearanceFor()', async () => {
    const loadTemplate = vi.fn(async (planet: string) => makeFakeTemplate(planet));
    const knowledge = new KnowledgeImpl({
      terrain: { loadTemplate, buildAppearance: () => makeFakeAppearance(7) },
    });
    await knowledge.preload({ planets: ['naboo'] });
    const a = await knowledge.terrain.appearanceFor('naboo');
    expect(a.getHeight(1, 2)).toBe(10);
    expect(loadTemplate).toHaveBeenCalledTimes(1);
  });
});

// ──────────────────────────────────────────────────────────────────────
// KnowledgeImpl.clear — delegates to every KB.
//
// The StringKBImpl is currently a stub whose `evict` / `clear` / `size`
// are no-ops (Track B will fill in `resolve` / `resolveFile`). So
// `Knowledge.clear()` exercises both delegations without exceptions.
// ──────────────────────────────────────────────────────────────────────

describe('KnowledgeImpl.clear', () => {
  it('clear() drops every cached terrain entry', async () => {
    const loadTemplate = vi.fn(async (planet: string) => makeFakeTemplate(planet));
    const knowledge = new KnowledgeImpl({
      terrain: { loadTemplate, buildAppearance: () => makeFakeAppearance() },
    });
    await knowledge.terrain.appearanceFor('naboo');
    await knowledge.terrain.appearanceFor('rori');
    expect(knowledge.terrain.size()).toBe(2);

    knowledge.clear();

    expect(knowledge.terrain.size()).toBe(0);
    // strings.size() is 0 anyway under the stub; confirm clear() didn't throw.
    expect(knowledge.strings.size()).toBe(0);
  });

  it('clear() also invokes strings.clear() (via a tracked mock)', () => {
    // Build a Knowledge then monkey-patch its strings KB clear() to assert
    // the delegation. We can't easily inject a custom StringKB through the
    // public KnowledgeOptions surface today, so this is the cleanest
    // assertion that doesn't require touching the prod KB seam.
    const knowledge = new KnowledgeImpl();
    const clearSpy = vi.spyOn(knowledge.strings, 'clear');
    knowledge.clear();
    expect(clearSpy).toHaveBeenCalledTimes(1);
  });
});

describe('defaultKnowledge', () => {
  it('is a real KnowledgeImpl (not a throwing stub) — terrain + strings are addressable', async () => {
    const { defaultKnowledge } = await import('./knowledge.js');
    expect(defaultKnowledge).toBeDefined();
    // These getters used to throw under KnowledgeStub; the new default must
    // expose real instances.
    expect(defaultKnowledge.terrain).toBeDefined();
    expect(defaultKnowledge.strings).toBeDefined();
    expect(typeof defaultKnowledge.terrain.appearanceFor).toBe('function');
    expect(typeof defaultKnowledge.strings.resolve).toBe('function');
    expect(typeof defaultKnowledge.clear).toBe('function');
    expect(typeof defaultKnowledge.preload).toBe('function');
  });
});
