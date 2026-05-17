/**
 * SOE TRE filename CRC32.
 *
 * This is the polynomial 0x04C11DB7 Ross-Williams CRC variant used by
 * `sharedFoundation/Crc.cpp::Crc::calculate`. NOT the standard zlib CRC32
 * (which uses the reversed polynomial 0xEDB88320 and is right-shift based).
 *
 * Maps to:
 *   /home/tharper/code/swg-main/src/engine/shared/library/sharedFoundation/src/shared/Crc.cpp
 *   `Crc::calculate(const char *)` (lines 66-77) and the 256-entry crctable (lines 23-57).
 *
 * The TRE TOC is sorted by this CRC for binary search lookups. Filename
 * normalization (lowercase, forward slashes) is applied before hashing —
 * see `tre-reader.ts::normalizeFilename`.
 */

import type { Buffer } from 'node:buffer';

/** CRC-32/MPEG-2 polynomial. */
const POLY = 0x04c11db7;
/** Initial / final XOR value. */
const INIT = 0xffffffff;

/**
 * Pre-computed 256-entry lookup table. Matches the literal `crctable[]` in
 * `Crc.cpp` lines 23-57 byte-for-byte.
 */
const CRC_TABLE: Uint32Array = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = (i << 24) >>> 0;
    for (let j = 0; j < 8; j++) {
      if ((c & 0x80000000) !== 0) {
        c = ((c << 1) ^ POLY) >>> 0;
      } else {
        c = (c << 1) >>> 0;
      }
    }
    table[i] = c;
  }
  return table;
})();

/**
 * Compute the SOE CRC32 of a string. The string is treated as a sequence of
 * bytes (ASCII / Latin-1) — non-ASCII codepoints are masked to their low 8
 * bits to match how the C++ reads `char` values. For TRE filenames the input
 * is always lowercase ASCII.
 *
 * Returns a uint32 (0..0xFFFFFFFF).
 */
export function treFilenameCrc(filename: string): number {
  let crc = INIT;
  for (let i = 0; i < filename.length; i++) {
    const b = filename.charCodeAt(i) & 0xff;
    const idx = ((crc >>> 24) ^ b) & 0xff;
    const tableVal = CRC_TABLE[idx];
    if (tableVal === undefined) throw new Error('crc32 table lookup failed (impossible)');
    crc = (tableVal ^ ((crc << 8) >>> 0)) >>> 0;
  }
  return (crc ^ INIT) >>> 0;
}

/**
 * Same algorithm but for an explicit byte buffer. Used by tests + by code
 * paths that already have UTF-8 bytes on hand.
 */
export function treFilenameCrcBytes(bytes: Uint8Array | Buffer): number {
  let crc = INIT;
  for (let i = 0; i < bytes.byteLength; i++) {
    const b = bytes[i];
    if (b === undefined) throw new Error('impossible: byte index undefined');
    const idx = ((crc >>> 24) ^ b) & 0xff;
    const tableVal = CRC_TABLE[idx];
    if (tableVal === undefined) throw new Error('crc32 table lookup failed (impossible)');
    crc = (tableVal ^ ((crc << 8) >>> 0)) >>> 0;
  }
  return (crc ^ INIT) >>> 0;
}
