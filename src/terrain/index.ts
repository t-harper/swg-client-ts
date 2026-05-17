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

export type { BuildableProbeResult, ProbeOptions } from './probe.js';
export { DEFAULT_PROBE_DEED, probeBuildable } from './probe.js';

export type { FindFlatPatchOptions, FlatSpot } from './find-flat-patch.js';
export { findFlatPatch, generateCandidateGrid } from './find-flat-patch.js';
