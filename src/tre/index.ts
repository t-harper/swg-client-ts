/**
 * Public surface for the TRE (SOE TreeFile) archive reader + writer.
 * See `tre-reader.ts` for the on-disk layout and the C++ reference.
 */

export { TreReader, normalizeFilename } from './tre-reader.js';
export type { TreEntry } from './tre-reader.js';
export { TreWriter } from './tre-writer.js';
export type { TreAddOptions, TreBuildOptions } from './tre-writer.js';
export { treFilenameCrc, treFilenameCrcBytes } from './tre-crc.js';
