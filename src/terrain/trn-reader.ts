/**
 * TRN ("Procedural Terrain Appearance") metadata reader.
 *
 * Reads just the top-level `PTAT > 0015 > DATA` chunk of a `.trn` file and
 * extracts the map-level constants the buildability layer needs (map width
 * in meters, chunk width in meters). The full terrain layer graph
 * (fractals, affectors, flora maps, etc.) is intentionally NOT decoded —
 * porting the full C++ TerrainGenerator would be thousands of lines of
 * fractal/affector code, and the empirical-probe strategy bypasses it
 * entirely. This reader exists to give us coordinate-space sanity checks
 * (e.g. "is x=2828 inside the map?") and to drive the grid-search bounds.
 *
 * Reference C++ (DATA chunk layout, version 0015):
 *   /home/tharper/code/swg-main/src/engine/shared/library/sharedTerrain/src/shared/appearance/ProceduralTerrainAppearanceTemplate.cpp:872..933
 *
 * On-disk layout (relevant prefix):
 *
 *   FORM 'PTAT'
 *     FORM '0015'        (also '0013' and '0014' are accepted by the C++ loader)
 *       DATA
 *         cstring name                              ← e.g. "C:\\swg\\test\\data\\sku.0\\sys.shared\\built\\game\\terrain\\naboo.trn"
 *         f32     mapWidthInMeters                  ← square map (== width == depth)
 *         f32     chunkWidthInMeters                ← rectangular subdivision
 *         i32     numberOfTilesPerChunk
 *         i32     useGlobalWaterTable               ← bool-as-int32
 *         f32     globalWaterTableHeight
 *         f32     globalWaterTableShaderSize
 *         cstring globalWaterTableShaderTemplateName
 *         f32     environmentCycleTime
 *         ...
 *
 * All chunk-internal numbers are **little-endian** despite the IFF block
 * headers being big-endian (see `_iff-minimal.ts` for the why).
 */

import { readFileSync } from 'node:fs';
import { MinimalIff, packTag, unpackTag } from './_iff-minimal.js';

/** Top-level terrain parameters needed by the buildability search. */
export interface TrnMetadata {
  /** Map edge length in meters (Naboo, Tatooine, etc. are 16384 m). */
  readonly mapWidth: number;
  /** Edge length of a single procedurally-generated chunk in meters. */
  readonly chunkWidth: number;
  /** `mapWidth / chunkWidth` — number of chunks along one axis. */
  readonly numChunksPerSide: number;
  /** Original file path string embedded by the editor (debug-only). */
  readonly sourceName: string;
  /** The PTAT-version sub-form tag actually present (e.g. '0015'). */
  readonly version: string;
  /** Water-table height in meters, if a global water table is enabled; null otherwise. */
  readonly globalWaterHeight: number | null;
}

/** Tag of the top-level FORM in a `.trn` file: 'PTAT'. */
export const PTAT_TAG = packTag('PTAT');
/** Tag of the inner DATA chunk that carries the top-level params. */
export const PTAT_DATA_TAG = packTag('DATA');

/** Versions of the PTAT sub-form the C++ loader accepts. */
const SUPPORTED_VERSIONS = new Set<string>(['0013', '0014', '0015']);

/**
 * Read top-level metadata from a `.trn` file on disk.
 *
 * Validates that:
 *   - the file is IFF (starts with 'FORM')
 *   - the top form is 'PTAT'
 *   - the version sub-form is one the C++ loader supports
 *   - the DATA chunk decodes to sensible numbers (mapWidth divisible by chunkWidth)
 *
 * @throws Error with a descriptive message on any validation failure.
 */
export function readTrnMetadata(path: string): TrnMetadata {
  const buf = readFileSync(path);
  return parseTrnMetadata(buf);
}

/**
 * Same as `readTrnMetadata` but operates on an in-memory buffer. Use this
 * when the file is already loaded (tests, network streams, etc.).
 */
export function parseTrnMetadata(buf: Uint8Array): TrnMetadata {
  const iff = new MinimalIff(buf);
  if (!iff.hasFormHeader()) {
    throw new Error('parseTrnMetadata: file does not start with "FORM" — not an IFF file');
  }

  // FORM 'PTAT'
  iff.enterForm('PTAT');

  // FORM '0015' (or 0013/0014 — we just check it's one of the accepted tags).
  const versionTag = iff.enterForm();
  const version = unpackTag(versionTag);
  if (!SUPPORTED_VERSIONS.has(version)) {
    throw new Error(
      `parseTrnMetadata: unsupported PTAT version '${version}' (supported: ${[...SUPPORTED_VERSIONS].join(', ')})`,
    );
  }

  // DATA chunk: name + mapWidth + chunkWidth + ...
  iff.enterChunk('DATA');
  const sourceName = iff.readCString();
  const mapWidth = iff.readFloat32();
  const chunkWidth = iff.readFloat32();
  // We don't need any further fields, but read the next few for the water
  // table — useful for "is this point underwater?" gating. Wrapped in
  // try/catch so a truncated DATA chunk (unlikely but possible for some
  // pre-release maps) doesn't take out the whole metadata read.
  let globalWaterHeight: number | null = null;
  try {
    const _numberOfTilesPerChunk = iff.readInt32();
    void _numberOfTilesPerChunk;
    const useGlobalWaterTable = iff.readInt32() !== 0;
    const waterHeight = iff.readFloat32();
    globalWaterHeight = useGlobalWaterTable ? waterHeight : null;
  } catch {
    globalWaterHeight = null;
  }
  iff.exitChunk();
  iff.exitForm(); // exit version form
  iff.exitForm(); // exit PTAT

  // Sanity checks — sane terrain maps are 8192 or 16384 m square divided
  // into 32 / 64 / 128 / 256 m chunks. A garbage value here means we
  // mis-parsed the chunk layout.
  if (!Number.isFinite(mapWidth) || mapWidth <= 0 || mapWidth > 65536) {
    throw new Error(`parseTrnMetadata: nonsensical mapWidth=${mapWidth}`);
  }
  if (!Number.isFinite(chunkWidth) || chunkWidth <= 0 || chunkWidth > mapWidth) {
    throw new Error(
      `parseTrnMetadata: nonsensical chunkWidth=${chunkWidth} (mapWidth=${mapWidth})`,
    );
  }
  if (Math.abs((mapWidth / chunkWidth) % 1) > 1e-3) {
    throw new Error(
      `parseTrnMetadata: mapWidth (${mapWidth}) is not an integer multiple of chunkWidth (${chunkWidth})`,
    );
  }

  return {
    mapWidth,
    chunkWidth,
    numChunksPerSide: Math.round(mapWidth / chunkWidth),
    sourceName,
    version,
    globalWaterHeight,
  };
}
