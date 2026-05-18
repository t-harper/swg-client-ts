/**
 * Parameterized planet-coverage test for the procedural-terrain port.
 *
 * Discovers every `.trn` available locally (`listPlanets()` walks the
 * configured `.tre` archive — usually `~/code/swg-main/dist/prebuilt/
 * swgsource_3.0.tre` — and we also scan the two extracted on-disk paths
 * used by `extractedTrnSearchPaths()` so the test surfaces every planet
 * whether it's archived or extracted). For each discovered planet we
 * run an independently-visible `it()` that:
 *
 *   1. Loads via `loadPlanetTrnTemplate(planet)` — must not throw.
 *   2. Asserts the parsed template has plausible metadata
 *      (`mapWidth > 0`, layers.length > 0, fractalGroup family count > 0).
 *   3. Computes heights at 5 stratified coords spanning the planet's map
 *      (`-mapWidth/2 .. +mapWidth/2`) — each call must not throw and
 *      either returns a finite height in [-2000, 2000] or NaN (which the
 *      MVP carving affectors set for road / river / ribbon cells).
 *
 * A planet that isn't discovered locally is skipped, not failed (the test
 * shouldn't break in fresh checkouts that haven't staged the .tre / .trn
 * files).
 *
 * Naboo's existing dedicated smoke test (`load-naboo.test.ts`) keeps its
 * own targeted assertions and cache-behavior coverage; this one is the
 * broad sweep across every other world.
 */

import { describe, expect, it } from 'vitest';
import { existsSync, readdirSync } from 'node:fs';
import { extractedTrnSearchPaths, listPlanets } from '../asset-loader.js';
import { loadPlanetTrnTemplate } from './proc-terrain-template.js';
import { ProceduralTerrainAppearance } from './proc-terrain-appearance.js';

/**
 * The user-listed worlds the test is expected to cover, plus a handful
 * of dungeon / instance terrains that share the same wire format. Used
 * as the "always probe these names" set in case neither `listPlanets()`
 * nor the extracted-dir scan returns one of them — gives a clear
 * skip reason rather than silently dropping the planet from the run.
 */
const KNOWN_PLANETS = [
  // Live worlds
  'tatooine', 'naboo', 'corellia', 'dantooine', 'dathomir',
  'endor', 'lok', 'rori', 'talus', 'yavin4',
  // Expansions
  'kashyyyk', 'mustafar', 'taanab', 'umbra',
  // Kashyyyk dungeon variants (share the procedural-terrain pipeline)
  'kashyyyk_dead_forest', 'kashyyyk_main', 'kashyyyk_hunting',
  'kashyyyk_rryatt_trail', 'kashyyyk_pob_dungeons',
  'kashyyyk_north_dungeons', 'kashyyyk_south_dungeons',
];

/**
 * Filenames in `serverdata/terrain/` that ship with the engine but aren't
 * playable worlds — engine smoke fixtures, single-shader test cases,
 * tooling scratch terrains. They typically have zero fractal families
 * (so the "families > 0" assertion below would fail) and aren't worth
 * exercising in the cross-planet sweep. Detection is name-pattern-based
 * so any newly-added test scene flows through without churning this file.
 */
function looksLikeTestFixture(name: string): boolean {
  // Obvious test-fixture name patterns: pure-numeric IDs ('09', '10', '11'),
  // names ending in '_test' / 'test', and the well-known one-off scenes.
  if (/^\d+$/.test(name)) return true;
  if (/test$/.test(name) || /_test$/.test(name) || /^test_/.test(name)) return true;
  if (/^(simple|character_farm|dungeon\d+|tutorial|runtimerules|floratest)$/.test(name)) return true;
  return false;
}

/**
 * Discover every playable planet whose `.trn` is loadable locally. Combines:
 *   - `listPlanets()` — what `terrain/<name>.trn` entries the configured
 *     `.tre` archive exposes
 *   - directory scan of each `extractedTrnSearchPaths()` entry — surfaces
 *     planets that exist as extracted on-disk files but aren't in the
 *     archive (common SWG mod-tooling setup keeps the `serverdata/terrain/`
 *     tree extracted)
 *   - `KNOWN_PLANETS` union — last-resort fallback so the user-listed set
 *     always appears in the test output (even if just as a skip)
 *
 * Names flagged by `looksLikeTestFixture` are filtered out at the source
 * (they have zero fractal families and aren't real worlds).
 * Results are de-duplicated and sorted for stable ordering.
 */
function discoverAvailablePlanets(): string[] {
  const all = new Set<string>();

  // 1. TRE archive (silently absent in fresh checkouts).
  try {
    for (const p of listPlanets()) {
      if (!looksLikeTestFixture(p)) all.add(p);
    }
  } catch {
    // No archive — fall through to disk scan.
  }

  // 2. Extracted on-disk paths. We probe both standard locations
  //    (`<cwd>/assets/terrain/` and `<cwd>/../swg-main/serverdata/terrain/`)
  //    by inspecting their parent directories directly — that's the only
  //    place the asset-loader publicly exposes the search roots.
  const probedDirs = new Set<string>();
  for (const probePath of extractedTrnSearchPaths('naboo')) {
    const dir = probePath.substring(0, probePath.lastIndexOf('/'));
    if (probedDirs.has(dir)) continue;
    probedDirs.add(dir);
    if (!existsSync(dir)) continue;
    for (const file of readdirSync(dir)) {
      if (!file.endsWith('.trn')) continue;
      // Skip space sectors — they use a different `STAT` IFF root and
      // the procedural template loader correctly refuses them; running
      // them through this suite would just generate noise.
      if (file.startsWith('space_')) continue;
      const planet = file.replace(/\.trn$/, '');
      if (!looksLikeTestFixture(planet)) all.add(planet);
    }
  }

  // 3. Ensure the curated set is surfaced even when nothing is on disk —
  //    those planets will simply produce skipped sub-tests below.
  for (const p of KNOWN_PLANETS) all.add(p);

  return Array.from(all).sort();
}

/** Returns true iff the named planet can be loaded (file exists either extracted or in TRE). */
function hasPlanet(planet: string): boolean {
  for (const candidate of extractedTrnSearchPaths(planet)) {
    if (existsSync(candidate)) return true;
  }
  try {
    return listPlanets().includes(planet);
  } catch {
    return false;
  }
}

/**
 * Build the 5 stratified probe coords for a map of the given full width.
 * The center-zero, plus four quadrant probes at 50/70 % of the half-width
 * so each one sits well inside `[-mapWidth/2, +mapWidth/2]` (which is the
 * playable extent of every shipping SWG planet — center is the origin).
 */
function probesForMap(mapWidth: number): Array<readonly [number, number]> {
  const hw = mapWidth / 2;
  return [
    [0, 0],
    [hw * 0.5, -hw * 0.5],
    [-hw * 0.7, hw * 0.7],
    [hw * 0.3, hw * 0.6],
    [-hw * 0.5, -hw * 0.3],
  ];
}

const PLANETS = discoverAvailablePlanets();

describe('procedural terrain — all planets coverage', () => {
  for (const planet of PLANETS) {
    const present = hasPlanet(planet);

    describe(planet, () => {
      it.skipIf(!present)('loads .trn without throwing and reports sane metadata', async () => {
        const template = await loadPlanetTrnTemplate(planet);
        expect(template.mapWidth).toBeGreaterThan(0);
        expect(template.terrainGenerator).toBeDefined();
        expect(template.terrainGenerator.layers.length).toBeGreaterThan(0);
        expect(template.terrainGenerator.fractalGroup.getNumberOfFamilies()).toBeGreaterThan(0);
      }, 30_000);

      it.skipIf(!present)('computes heights at 5 stratified coords (finite or NaN, in sane range)', async () => {
        const template = await loadPlanetTrnTemplate(planet);
        // Lightweight appearance — 9-pole chunks keep generation fast
        // enough to probe all five coords in well under the timeout.
        const app = new ProceduralTerrainAppearance(template, {
          numberOfPoles: 9,
          cacheCapacity: 16,
        });
        const probes = probesForMap(template.mapWidth);
        for (const [x, z] of probes) {
          let h: number;
          // Must not throw — wire-format mismatches surface here.
          expect(() => { h = app.getHeight(x, z); }).not.toThrow();
          // Per the spec, NaN is an acceptable result (it's how the MVP
          // carving affectors mark unbuildable road/river/ribbon cells).
          // Finite heights have to live in a sane range that no real
          // planet would ever exceed.
          h = app.getHeight(x, z);
          if (!Number.isNaN(h)) {
            expect(Number.isFinite(h)).toBe(true);
            expect(h).toBeGreaterThan(-2000);
            expect(h).toBeLessThan(2000);
          }
        }
      }, 60_000);
    });
  }
});
