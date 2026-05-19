/**
 * Terrain helpers — TRN metadata reader plus an empirical buildability
 * probe and a concentric-ring grid search for flat patches.
 *
 * The probe and search assume an admin-level live-server connection (they
 * spawn deeds via `object createIn`); the metadata reader is purely
 * offline file I/O.
 *
 * See `CLAUDE.md` § "find buildable spots" and the per-module headers
 * for usage details.
 */

export type { TrnMetadata } from './trn-reader.js';
export { PTAT_TAG, PTAT_DATA_TAG, parseTrnMetadata, readTrnMetadata } from './trn-reader.js';

// Planet-general asset loader — resolves any planet's .trn from a TRE archive
// or from on-disk extracted files. Recommended entry point: `loadPlanetTrn`.
export {
  clearTreCache,
  extractedTrnSearchPaths,
  getTreReader,
  listPlanets,
  loadPlanetTrn,
  loadTrnFromTre,
  readTrnMetadataForPlanet,
  resolveDefaultTrePath,
  trnPathForPlanet,
} from './asset-loader.js';

export type { BuildableProbeResult, ProbeOptions } from './probe.js';
export { DEFAULT_PROBE_DEED, probeBuildable } from './probe.js';

export type { FindFlatPatchOptions, FlatSpot } from './find-flat-patch.js';
export { findFlatPatch, generateCandidateGrid } from './find-flat-patch.js';

// Procedural terrain simulator — bit-exact port of the C++ `sharedTerrain` +
// `sharedFractal` libraries. Computes per-(x, z) heights for any planet
// offline (no live-server round-trip). See `./sim/index.ts` for the
// curated public surface.
export * from './sim/index.js';
