/**
 * Offline smoke test — loads the real naboo.trn from `assets/terrain/` and
 * confirms the full pipeline (template parse → TerrainGenerator load →
 * ProceduralTerrainAppearance.getHeight) runs without throwing.
 *
 * This does NOT validate bit-exact match to the server (that's
 * `tests/integration/live-terrain-getheight.test.ts`). It just proves the
 * loader / chunk-eval plumbing is sound. If the .trn isn't staged in
 * `assets/terrain/naboo.trn`, the test is skipped.
 */

import { describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { loadProceduralTerrainTemplate } from './proc-terrain-template.js';
import { ProceduralTerrainAppearance } from './proc-terrain-appearance.js';

const NABOO_PATH = join(
  process.cwd(),
  'assets',
  'terrain',
  'naboo.trn',
);
const HAS_NABOO = existsSync(NABOO_PATH);

describe.skipIf(!HAS_NABOO)('procedural terrain — naboo.trn end-to-end', () => {
  it('loads the .trn without throwing and reports sane metadata', async () => {
    const buf = await readFile(NABOO_PATH);
    const template = loadProceduralTerrainTemplate(new Uint8Array(buf));
    expect(template.mapWidth).toBe(16384);
    expect(template.chunkWidth).toBeGreaterThan(0);
    expect(template.chunkWidth).toBeLessThan(1024);
    expect(template.terrainGenerator).toBeDefined();
    expect(template.terrainGenerator.layers.length).toBeGreaterThan(0);
    expect(template.terrainGenerator.fractalGroup.getNumberOfFamilies()).toBeGreaterThan(0);
  }, 30_000);

  it('computes heights at a handful of arbitrary Naboo coords without throwing', async () => {
    const buf = await readFile(NABOO_PATH);
    const template = loadProceduralTerrainTemplate(new Uint8Array(buf));
    const app = new ProceduralTerrainAppearance(template, {
      numberOfPoles: 9, // small chunk grid for speed (1 m grid on 8 m chunks roughly)
      cacheCapacity: 16,
    });
    const probes: Array<[number, number]> = [
      [0, 0],
      [2800, -2800],         // build-city's CITY_CENTER
      [-5000, 5000],
      [4000, 1000],
      [-3500, -1500],
    ];
    for (const [x, z] of probes) {
      const h = app.getHeight(x, z);
      // We don't know what the server says — but heights should be a finite
      // number (or NaN for carved cells). They are typically in [-200, 400]
      // for Naboo; we just guard the obviously-broken range.
      if (!Number.isNaN(h)) {
        expect(Number.isFinite(h)).toBe(true);
        expect(h).toBeGreaterThan(-2000);
        expect(h).toBeLessThan(2000);
      }
    }
  }, 60_000);

  it('caches chunks across repeated queries within the same chunk', async () => {
    const buf = await readFile(NABOO_PATH);
    const template = loadProceduralTerrainTemplate(new Uint8Array(buf));
    const app = new ProceduralTerrainAppearance(template, {
      numberOfPoles: 9,
      cacheCapacity: 16,
    });
    const before = app.cacheSize();
    expect(before).toBe(0);
    app.getHeight(100, 100);
    const after1 = app.cacheSize();
    expect(after1).toBe(1);
    // Same chunk — no new cache entry.
    app.getHeight(101, 101);
    expect(app.cacheSize()).toBe(1);
    // Different chunk — one more.
    app.getHeight(5000, 5000);
    expect(app.cacheSize()).toBe(2);
  }, 60_000);
});
