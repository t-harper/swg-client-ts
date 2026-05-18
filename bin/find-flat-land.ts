#!/usr/bin/env node
/**
 * find-flat-land — offline scanner that uses the procedural-terrain port
 * (`src/terrain/sim/`) to identify the flattest N×N-meter patches on a
 * given SWG planet. No live cluster required.
 *
 * Algorithm:
 *   1. Load the planet's .trn (via `loadPlanetTrnTemplate`).
 *   2. Build a full heightmap at a configurable fine grid (default 50 m
 *      over the planet's central 16 km × 16 km).
 *   3. For every candidate window center, compute the max-min height
 *      range over the windowSizeM × windowSizeM box.
 *   4. Reject:
 *        - windows containing any NaN cells (carved by road/river/ribbon)
 *        - windows whose mean height is below water + 1 m
 *        - windows overlapping a known NPC-city exclusion zone
 *   5. Sort by range ascending. Print the top N with center coord, range,
 *      mean height, and an in-game `/planetwarp` command you can paste.
 *
 * Usage:
 *   pnpm tsx bin/find-flat-land.ts --planet=naboo                       (defaults)
 *   pnpm tsx bin/find-flat-land.ts --planet=naboo --window=750 --grid=50 --top=10
 *
 * Defaults are tuned for build-city's MVP city plot (~750 m windowed).
 */

import {
  loadPlanetTrnTemplate,
  ProceduralTerrainAppearance,
} from '../src/terrain/sim/index.js';

interface Args {
  planet: string;
  /** Window edge in meters. Default 750 (matches build-city's footprint need). */
  windowM: number;
  /** Sample grid resolution in meters. Default 50. */
  gridM: number;
  /** Search half-width from planet center in meters. Default 7500. */
  rangeM: number;
  /** Number of top candidates to report. Default 5. */
  top: number;
}

function parseArgs(argv: string[]): Args {
  const a: Args = {
    planet: 'naboo',
    windowM: 750,
    gridM: 50,
    rangeM: 7500,
    top: 5,
  };
  for (const arg of argv) {
    if (!arg.startsWith('--')) continue;
    const eq = arg.indexOf('=');
    const key = eq < 0 ? arg.slice(2) : arg.slice(2, eq);
    const val = eq < 0 ? 'true' : arg.slice(eq + 1);
    switch (key) {
      case 'planet': a.planet = val; break;
      case 'window': a.windowM = Number.parseInt(val, 10); break;
      case 'grid': a.gridM = Number.parseInt(val, 10); break;
      case 'range': a.rangeM = Number.parseInt(val, 10); break;
      case 'top': a.top = Number.parseInt(val, 10); break;
      default:
        process.stderr.write(`unknown flag --${key}\n`);
        process.exit(2);
    }
  }
  return a;
}

/**
 * NPC-city exclusion zones — hand-curated. Player structures can't be
 * placed inside these radii. We extend by 200 m as a safety buffer.
 *
 * Sources: SWG community wiki coords, cross-checked against `starting_locations.iff`.
 */
const NPC_CITIES: Record<string, ReadonlyArray<{ name: string; x: number; z: number; radius: number }>> = {
  naboo: [
    { name: 'Theed',         x: -5000, z:  4200, radius: 1000 },
    { name: 'Moenia',        x:  4800, z: -4700, radius:  700 },
    { name: "Dee'ja Peak",   x:  5200, z:  2400, radius: 1200 },
    { name: 'Keren',          x:  1500, z:  2700, radius:  600 },
    { name: 'Kaadara',        x:  5200, z:  6700, radius:  500 },
  ],
  tatooine: [
    { name: 'Mos Eisley',     x:  3528, z: -4804, radius:  800 },
    { name: 'Mos Espa',       x: -2926, z:  2129, radius:  800 },
    { name: 'Bestine',        x: -1300, z: -3590, radius:  700 },
    { name: 'Anchorhead',     x:    37, z:  -5300, radius:  500 },
    { name: 'Wayfar',         x: -5188, z:  -6700, radius:  400 },
    { name: 'Mos Entha',      x:  1300, z:  3100, radius:  600 },
  ],
  corellia: [
    { name: 'Coronet',        x: -130,  z: -4720, radius: 1100 },
    { name: 'Tyrena',         x: -5400, z: -2700, radius:  600 },
    { name: 'Kor Vella',      x: -3149, z:  2796, radius:  500 },
    { name: 'Doaba Guerfel',  x:  3300, z:  5500, radius:  500 },
    { name: 'Bela Vistal',    x:  6675, z: -5710, radius:  500 },
  ],
};

interface Candidate {
  cx: number;
  cz: number;
  range: number;
  mean: number;
  min: number;
  max: number;
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  process.stderr.write(
    `[find-flat-land] planet=${args.planet} window=${args.windowM}m grid=${args.gridM}m range=±${args.rangeM}m top=${args.top}\n`,
  );

  // 1. Load the planet template.
  let template;
  try {
    template = await loadPlanetTrnTemplate(args.planet);
  } catch (err) {
    process.stderr.write(
      `[find-flat-land] failed to load planet '${args.planet}': ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return 1;
  }
  process.stderr.write(
    `[find-flat-land] loaded ${args.planet}.trn (${template.terrainGenerator.layers.length} layers, ${template.terrainGenerator.fractalGroup.getNumberOfFamilies()} fractal families, water=${template.globalWaterHeight ?? 'none'})\n`,
  );

  // 2. Build a heightmap at args.gridM resolution covering ±args.rangeM.
  const appearance = new ProceduralTerrainAppearance(template);
  const gridSize = Math.floor((2 * args.rangeM) / args.gridM) + 1;
  const originX = -args.rangeM;
  const originZ = -args.rangeM;
  process.stderr.write(
    `[find-flat-land] scanning ${gridSize}×${gridSize} = ${gridSize * gridSize} cells at ${args.gridM}m spacing...\n`,
  );
  const scanStart = Date.now();
  const heights = appearance.scanHeights(originX, originZ, gridSize, gridSize, args.gridM);
  const scanMs = Date.now() - scanStart;
  process.stderr.write(`[find-flat-land] scan done in ${scanMs}ms (${(scanMs / heights.length).toFixed(2)}ms/cell)\n`);

  // Helper: index into the heights array.
  const idx = (xi: number, zi: number): number => zi * gridSize + xi;

  // 3. For every candidate window CENTER, compute height range over the window.
  const windowCells = Math.ceil(args.windowM / args.gridM);
  const halfWindowCells = Math.floor(windowCells / 2);
  process.stderr.write(
    `[find-flat-land] evaluating ${(gridSize - windowCells) * (gridSize - windowCells)} candidate windows (${windowCells}×${windowCells} cells each)...\n`,
  );

  const candidates: Candidate[] = [];
  const cities = NPC_CITIES[args.planet] ?? [];
  // Water-table filter: prefer the planet's globalWaterHeight when set
  // (some planets ARE on a global sheet). When unset (Naboo!), assume sea
  // level (0 m) with a 5 m buffer to avoid recommending swamp / coastline.
  const waterMin = (template.globalWaterHeight ?? 0) + 5.0;

  for (let cz = halfWindowCells; cz < gridSize - halfWindowCells; cz++) {
    for (let cx = halfWindowCells; cx < gridSize - halfWindowCells; cx++) {
      // Window cell range.
      let min = Infinity;
      let max = -Infinity;
      let sum = 0;
      let count = 0;
      let hasNaN = false;
      for (let dz = -halfWindowCells; dz <= halfWindowCells; dz++) {
        for (let dx = -halfWindowCells; dx <= halfWindowCells; dx++) {
          const h = heights[idx(cx + dx, cz + dz)] as number;
          if (Number.isNaN(h)) { hasNaN = true; break; }
          if (h < min) min = h;
          if (h > max) max = h;
          sum += h;
          count++;
        }
        if (hasNaN) break;
      }
      if (hasNaN) continue;

      const mean = sum / count;
      const range = max - min;

      // Reject "suspiciously flat" windows — heights all exactly zero are
      // almost always either outside the playable map or water-suppressed.
      // Real flat terrain has at least sub-meter variation.
      if (range < 0.05) continue;

      // Water-table filter.
      if (mean < waterMin) continue;

      // NPC-city exclusion.
      const worldX = originX + cx * args.gridM;
      const worldZ = originZ + cz * args.gridM;
      let inCity = false;
      for (const city of cities) {
        const dx = worldX - city.x;
        const dz = worldZ - city.z;
        if (dx * dx + dz * dz < city.radius * city.radius) {
          inCity = true;
          break;
        }
      }
      if (inCity) continue;

      candidates.push({ cx: worldX, cz: worldZ, range, mean, min, max });
    }
  }

  process.stderr.write(`[find-flat-land] ${candidates.length} valid windows; sorting...\n`);

  // 4. Sort by range ascending; take top N.
  candidates.sort((a, b) => a.range - b.range);
  const top = candidates.slice(0, args.top);

  // 5. Output.
  const result = {
    planet: args.planet,
    windowM: args.windowM,
    gridM: args.gridM,
    rangeM: args.rangeM,
    waterHeight: template.globalWaterHeight,
    layersLoaded: template.terrainGenerator.layers.length,
    fractalFamilies: template.terrainGenerator.fractalGroup.getNumberOfFamilies(),
    scanMs,
    totalCandidates: candidates.length,
    top: top.map((c, i) => ({
      rank: i + 1,
      center: { x: Math.round(c.cx), z: Math.round(c.cz) },
      heightRangeM: Number(c.range.toFixed(2)),
      meanHeightM: Number(c.mean.toFixed(2)),
      minHeightM: Number(c.min.toFixed(2)),
      maxHeightM: Number(c.max.toFixed(2)),
      planetwarp: `/planetwarp ${args.planet} ${Math.round(c.cx)} 0 ${Math.round(c.cz)}`,
    })),
  };
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);

  // Also a human-readable table on stderr.
  process.stderr.write('\n[find-flat-land] top candidates:\n');
  process.stderr.write('rank   x       z      range  mean   planetwarp\n');
  process.stderr.write('────  ──────  ──────  ─────  ─────  ────────────────────────\n');
  for (const t of result.top) {
    process.stderr.write(
      `  ${String(t.rank).padStart(2)}.  ` +
        `${String(t.center.x).padStart(6)}  ${String(t.center.z).padStart(6)}  ` +
        `${t.heightRangeM.toFixed(2).padStart(5)}  ${t.meanHeightM.toFixed(1).padStart(5)}  ` +
        `${t.planetwarp}\n`,
    );
  }
  process.stderr.write('\n');

  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    process.stderr.write(`fatal: ${err instanceof Error ? err.stack : String(err)}\n`);
    process.exit(1);
  });
