import { describe, expect, it, vi } from 'vitest';

import type {
  ProceduralTerrainAppearance,
  ProceduralTerrainTemplate,
} from '../terrain/sim/index.js';
import { createTerrainView } from './terrain-view.js';

/**
 * Minimal fake appearance — only what the view contract touches:
 *   - `getHeight(x, z): number`
 * The view itself never reads other fields.
 */
function makeFakeAppearance(seed = 0): ProceduralTerrainAppearance {
  return {
    getHeight: (x: number, z: number): number => seed + x + z,
  } as unknown as ProceduralTerrainAppearance;
}

function makeFakeTemplate(name: string): ProceduralTerrainTemplate {
  return { sourceName: name } as unknown as ProceduralTerrainTemplate;
}

describe('createTerrainView', () => {
  it('does NOT call the loader until appearance() is requested', () => {
    const loadTemplate = vi.fn(async () => makeFakeTemplate('naboo'));
    createTerrainView({
      getCurrentPlanet: () => 'naboo',
      loadTemplate,
      buildAppearance: () => makeFakeAppearance(),
    });
    expect(loadTemplate).not.toHaveBeenCalled();
  });

  it('lazy-loads the appearance for the current planet on first call', async () => {
    const loadTemplate = vi.fn(async (planet: string) => makeFakeTemplate(planet));
    const buildAppearance = vi.fn(() => makeFakeAppearance(100));
    const view = createTerrainView({
      getCurrentPlanet: () => 'naboo',
      loadTemplate,
      buildAppearance,
    });
    const appearance = await view.appearance();
    expect(loadTemplate).toHaveBeenCalledWith('naboo');
    expect(buildAppearance).toHaveBeenCalledTimes(1);
    expect(appearance.getHeight(10, 20)).toBe(130);
  });

  it('caches per-planet — repeated calls for the same planet return the same instance', async () => {
    const loadTemplate = vi.fn(async (planet: string) => makeFakeTemplate(planet));
    const view = createTerrainView({
      getCurrentPlanet: () => 'naboo',
      loadTemplate,
      buildAppearance: () => makeFakeAppearance(),
    });
    const a = await view.appearance();
    const b = await view.appearance();
    expect(a).toBe(b);
    expect(loadTemplate).toHaveBeenCalledTimes(1);
  });

  it('coalesces concurrent loads for the same planet into one in-flight promise', async () => {
    const loadTemplate = vi.fn(async (planet: string) => {
      // Force a tick so the second caller observes the in-flight promise.
      await new Promise((r) => setTimeout(r, 0));
      return makeFakeTemplate(planet);
    });
    const view = createTerrainView({
      getCurrentPlanet: () => 'naboo',
      loadTemplate,
      buildAppearance: () => makeFakeAppearance(),
    });
    const [a, b] = await Promise.all([view.appearance(), view.appearance()]);
    expect(a).toBe(b);
    expect(loadTemplate).toHaveBeenCalledTimes(1);
  });

  it('re-evaluates getCurrentPlanet on every call (so a mid-script zone picks up the new planet)', async () => {
    let current = 'naboo';
    const loadTemplate = vi.fn(async (planet: string) => makeFakeTemplate(planet));
    const view = createTerrainView({
      getCurrentPlanet: () => current,
      loadTemplate,
      buildAppearance: (t) => makeFakeAppearance(t.sourceName === 'naboo' ? 1 : 2),
    });
    const onNaboo = await view.appearance();
    expect(onNaboo.getHeight(0, 0)).toBe(1);

    current = 'rori';
    const onRori = await view.appearance();
    expect(onRori.getHeight(0, 0)).toBe(2);
    expect(loadTemplate).toHaveBeenCalledTimes(2);
  });

  it('appearanceFor(planet) loads an explicit planet regardless of current', async () => {
    const loadTemplate = vi.fn(async (planet: string) => makeFakeTemplate(planet));
    const view = createTerrainView({
      getCurrentPlanet: () => 'naboo',
      loadTemplate,
      buildAppearance: (t) => makeFakeAppearance(t.sourceName === 'naboo' ? 1 : 99),
    });
    const dath = await view.appearanceFor('dathomir');
    expect(dath.getHeight(0, 0)).toBe(99);
    expect(loadTemplate).toHaveBeenCalledWith('dathomir');
  });

  it('getHeight(x, z) delegates to the cached appearance', async () => {
    const loadTemplate = vi.fn(async (planet: string) => makeFakeTemplate(planet));
    const view = createTerrainView({
      getCurrentPlanet: () => 'naboo',
      loadTemplate,
      buildAppearance: () => makeFakeAppearance(7),
    });
    expect(await view.getHeight(3, 4)).toBe(14);
    // Second call hits the cache (loadTemplate still called once).
    expect(await view.getHeight(1, 1)).toBe(9);
    expect(loadTemplate).toHaveBeenCalledTimes(1);
  });

  it('does NOT cache failed loads — a retry triggers a fresh load attempt', async () => {
    let attempt = 0;
    const loadTemplate = vi.fn(async (planet: string) => {
      attempt++;
      if (attempt === 1) throw new Error(`asset missing for ${planet}`);
      return makeFakeTemplate(planet);
    });
    const view = createTerrainView({
      getCurrentPlanet: () => 'naboo',
      loadTemplate,
      buildAppearance: () => makeFakeAppearance(50),
    });
    await expect(view.appearance()).rejects.toThrow('asset missing for naboo');
    // The retry must succeed AND not see the cached failure.
    const ok = await view.appearance();
    expect(ok.getHeight(0, 0)).toBe(50);
    expect(loadTemplate).toHaveBeenCalledTimes(2);
  });
});

describe('public re-export surface', () => {
  it('exposes the procedural terrain types via the package barrel', async () => {
    const pkg = await import('../index.js');
    expect(typeof pkg.ProceduralTerrainAppearance).toBe('function');
    expect(typeof pkg.loadPlanetTrnTemplate).toBe('function');
    expect(typeof pkg.loadProceduralTerrainTemplate).toBe('function');
    expect(typeof pkg.TerrainGenerator).toBe('function');
  });
});
