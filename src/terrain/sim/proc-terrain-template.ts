/**
 * `ProceduralTerrainAppearanceTemplate` port — loads a full `.trn` file
 * (`PTAT > 0015 > {DATA, TGEN}`) and returns a ready-to-eval
 * `TerrainGenerator` plus the per-planet constants needed for chunk
 * generation (mapWidth, chunkWidth, water table, etc.).
 *
 * The existing `src/terrain/trn-reader.ts` handles the leading metadata
 * chunk (`DATA`). This file picks up after that and walks the `TGEN`
 * form, delegating to `TerrainGenerator.load`.
 *
 * C++ reference:
 *   `~/code/swg-main/src/engine/shared/library/sharedTerrain/src/shared/appearance/ProceduralTerrainAppearanceTemplate.cpp`
 */

import { Iff } from '../../iff/iff.js';
import { loadPlanetTrn } from '../asset-loader.js';
import { TerrainGenerator } from './generator/terrain-generator.js';

/** The full TRN metadata + a loaded TerrainGenerator ready for chunk eval. */
export interface ProceduralTerrainTemplate {
  /** Embedded path string from the editor (debug only). */
  sourceName: string;
  /** Map edge in meters. Naboo, Tatooine, etc. = 16384. */
  mapWidth: number;
  /** Procedural chunk edge in meters (typically 16 or 32). */
  chunkWidth: number;
  /** `mapWidth / chunkWidth`. */
  numChunksPerSide: number;
  /** PTAT sub-form tag actually present (e.g. '0015'). */
  version: string;
  /** Global water-table height in meters, or null if no global table. */
  globalWaterHeight: number | null;
  /** Ready-to-eval generator. Call `terrainGenerator.generateChunk(chunkData)`. */
  terrainGenerator: TerrainGenerator;
}

/**
 * Load a planet's full procedural-terrain template (metadata + layer
 * graph) from its `.trn` buffer.
 *
 * Use `loadPlanetTrnTemplate('naboo')` to resolve from the standard
 * asset locations (`assets/terrain/*.trn` or a `.tre` archive — see
 * `src/terrain/asset-loader.ts`).
 */
export function loadProceduralTerrainTemplate(trnBuffer: Uint8Array): ProceduralTerrainTemplate {
  const iff = Iff.fromBytes(trnBuffer);

  iff.enterForm('PTAT');
  const version = iff.enterAnyForm();
  if (version !== '0013' && version !== '0014' && version !== '0015') {
    throw new Error(`loadProceduralTerrainTemplate: unsupported PTAT version '${version}'`);
  }

  // ───── DATA chunk — metadata ─────
  iff.enterChunk('DATA');
  const sourceName = iff.readString();
  const mapWidth = iff.readF32();
  const chunkWidth = iff.readF32();
  // Skip the remaining metadata fields (numberOfTilesPerChunk, water-table,
  // shader-template name, etc.) — we capture water-table here.
  let globalWaterHeight: number | null = null;
  try {
    const _numberOfTilesPerChunk = iff.readI32();
    void _numberOfTilesPerChunk;
    const useGlobalWaterTable = iff.readI32() !== 0;
    const waterHeight = iff.readF32();
    globalWaterHeight = useGlobalWaterTable ? waterHeight : null;
  } catch {
    globalWaterHeight = null;
  }
  iff.exitChunk('DATA');

  // ───── TGEN form — the procedural layer graph ─────
  const terrainGenerator = new TerrainGenerator();
  terrainGenerator.load(iff);

  // We don't decode the remaining forms (baked terrain bitmaps, static
  // flora maps, etc.) — they're not needed for offline height eval.
  // Just exit the parent forms cleanly so the file handle is balanced.
  iff.exitForm(version);
  iff.exitForm('PTAT');

  return {
    sourceName,
    mapWidth,
    chunkWidth,
    numChunksPerSide: Math.round(mapWidth / chunkWidth),
    version,
    globalWaterHeight,
    terrainGenerator,
  };
}

/**
 * Resolve a planet's .trn from the standard asset locations and load
 * its full procedural template.
 *
 * Searches (via `asset-loader.ts`): extracted on-disk file first
 * (`assets/terrain/<planet>.trn`), then the .tre archive
 * (`SWG_TRE_PATH` env var or `~/code/swg-main/dist/prebuilt/`).
 */
export async function loadPlanetTrnTemplate(
  planet: string,
): Promise<ProceduralTerrainTemplate> {
  const buffer = await loadPlanetTrn(planet);
  return loadProceduralTerrainTemplate(buffer);
}
