/**
 * TRE (SOE TreeFile) archive READER.
 *
 * Maps to:
 *   /home/tharper/code/swg-main/src/engine/shared/library/sharedFile/src/shared/TreeFile_SearchNode.cpp
 *   (TreeFile::SearchTree constructor: lines 249-349; localExists binary search: 360-408;
 *    open path with optional per-file zlib expansion: 478-501)
 *
 * Wire layout (all integers little-endian on disk):
 *
 *   Header (36 bytes, sharedFile/TreeFile_SearchNode.h line 174):
 *     0  : 4   Tag    token      Constructed as ('T'<<24)|('R'<<16)|('E'<<8)|'E' = 0x54524545,
 *                                stored as native (little-endian) u32 → appears as bytes
 *                                "EERT" on disk.
 *     4  : 4   Tag    version    Same encoding: "0004" or "0005" intrinsically, appearing as
 *                                "4000" / "5000" byte-wise on disk.
 *     8  : 4   uint32 numberOfFiles
 *     12 : 4   uint32 tocOffset
 *     16 : 4   uint32 tocCompressor       (0 = none, 2 = zlib; 1 = deprecated)
 *     20 : 4   uint32 sizeOfTOC           (size of TOC on disk; compressed if tocCompressor!=0)
 *     24 : 4   uint32 blockCompressor     (0 = none, 2 = zlib)
 *     28 : 4   uint32 sizeOfNameBlock     (size of name-block on disk)
 *     32 : 4   uint32 uncompSizeOfNameBlock
 *
 *   TOC (numberOfFiles * 24 bytes uncompressed, optionally zlib-deflated on disk):
 *     0  : 4   uint32 crc                 (SOE Crc::calculate(filename), poly 0x04C11DB7)
 *     4  : 4   int32  length              (uncompressed file size; 0 == deleted)
 *     8  : 4   int32  offset              (byte offset of file data within archive)
 *     12 : 4   int32  compressor          (0/2 — per-file; independent of tocCompressor)
 *     16 : 4   int32  compressedLength
 *     20 : 4   int32  fileNameOffset      (byte offset within the uncompressed name block)
 *
 *   Name block (uncompSizeOfNameBlock bytes uncompressed, optionally deflated on disk):
 *     concatenated null-terminated lowercase ASCII filenames. Forward slashes only;
 *     no leading slash. TOC entries are sorted by crc ascending for binary search.
 *
 * The "filename hash" is NOT the standard zlib CRC32. It's the polynomial 0x04C11DB7
 * Ross-Williams CRC variant from `sharedFoundation/Crc.cpp`. See `tre-crc.ts`.
 */

import { Buffer } from 'node:buffer';
import { readFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';
import { treFilenameCrc } from './tre-crc.js';

/** Per-file entry as exposed to consumers. */
export interface TreEntry {
  /** Lowercase forward-slash filename as stored in the archive. */
  readonly filename: string;
  /** Uncompressed byte length. */
  readonly size: number;
  /** On-disk byte length (== `size` when `compressor === 0`). */
  readonly compressedSize: number;
  /** Per-file compression (0 = none, 2 = zlib). */
  readonly compressor: 0 | 2;
  /** Byte offset of the file data within the archive. */
  readonly offset: number;
  /** SOE CRC32 of the lowercase filename — the binary-search key. */
  readonly crc: number;
}

/** TRE header constants and layout. */
const HEADER_SIZE = 36;
const TOC_ENTRY_SIZE = 24;

/** ASCII tag "TREE" stored as a 4-byte big-endian integer (== "EERT" little-endian on disk). */
const TAG_TREE = 0x54524545;
/** ASCII tag "0004". */
const TAG_0004 = 0x30303034;
/** ASCII tag "0005". */
const TAG_0005 = 0x30303035;

const COMPRESSOR_NONE = 0;
const COMPRESSOR_ZLIB = 2;

/** Compressor field as a tagged literal (matches C++ `SearchTree::isCompressed`). */
function isZlibCompressor(c: number): c is 2 {
  if (c === COMPRESSOR_NONE) return false;
  if (c === COMPRESSOR_ZLIB) return true;
  // CT_deprecated == 1 is treated as fatal in the C++ source. Mirror that.
  throw new Error(`TRE compressor ${c} is not supported (0=none, 2=zlib; 1 is deprecated)`);
}

/** Raw header (decoded, not yet validated for compressor types). */
interface TreHeader {
  readonly version: number;
  readonly numberOfFiles: number;
  readonly tocOffset: number;
  readonly tocCompressor: number;
  readonly sizeOfTOC: number;
  readonly blockCompressor: number;
  readonly sizeOfNameBlock: number;
  readonly uncompSizeOfNameBlock: number;
}

function parseHeader(bytes: Buffer): TreHeader {
  if (bytes.byteLength < HEADER_SIZE) {
    throw new Error(
      `TRE archive too small (${bytes.byteLength} bytes); need at least ${HEADER_SIZE}`,
    );
  }
  // C++ stores tags as native uint32 (x86 = little-endian). The `Tag` value
  // TAG(T,R,E,E) = 0x54524545 (high byte 'T'). On disk the bytes appear as
  // "EERT". We read LE and compare against the integer constant — so the
  // comparison value matches the human-readable tag literal "TREE".
  const token = bytes.readUInt32LE(0);
  if (token !== TAG_TREE) {
    throw new Error(
      `not a TRE archive: expected magic 'TREE' (0x${TAG_TREE.toString(16)}), got 0x${token
        .toString(16)
        .padStart(8, '0')}`,
    );
  }
  const version = bytes.readUInt32LE(4);
  if (version !== TAG_0004 && version !== TAG_0005) {
    throw new Error(
      `unsupported TRE version: 0x${version
        .toString(16)
        .padStart(8, '0')} (only 0004/0005 supported)`,
    );
  }
  return {
    version,
    numberOfFiles: bytes.readUInt32LE(8),
    tocOffset: bytes.readUInt32LE(12),
    tocCompressor: bytes.readUInt32LE(16),
    sizeOfTOC: bytes.readUInt32LE(20),
    blockCompressor: bytes.readUInt32LE(24),
    sizeOfNameBlock: bytes.readUInt32LE(28),
    uncompSizeOfNameBlock: bytes.readUInt32LE(32),
  };
}

/** Decompress `slice` if `compressor` is zlib; otherwise return a copy. */
function maybeInflate(slice: Buffer, compressor: number, expectedUncompressedSize: number): Buffer {
  if (isZlibCompressor(compressor)) {
    const out = inflateSync(slice);
    if (out.byteLength !== expectedUncompressedSize) {
      throw new Error(
        `TRE inflate size mismatch: expected ${expectedUncompressedSize} bytes, got ${out.byteLength}`,
      );
    }
    return out;
  }
  if (slice.byteLength !== expectedUncompressedSize) {
    throw new Error(
      `TRE uncompressed block size mismatch: expected ${expectedUncompressedSize} bytes, got ${slice.byteLength}`,
    );
  }
  // Return a fresh copy so the caller can hold on past the source's lifetime.
  return Buffer.from(slice);
}

/** Read a single TOC entry from the uncompressed TOC blob at `offset`. */
function parseTocEntry(
  toc: Buffer,
  offset: number,
): {
  crc: number;
  length: number;
  fileOffset: number;
  compressor: number;
  compressedLength: number;
  fileNameOffset: number;
} {
  return {
    crc: toc.readUInt32LE(offset),
    length: toc.readInt32LE(offset + 4),
    fileOffset: toc.readInt32LE(offset + 8),
    compressor: toc.readInt32LE(offset + 12),
    compressedLength: toc.readInt32LE(offset + 16),
    fileNameOffset: toc.readInt32LE(offset + 20),
  };
}

/** Extract a null-terminated ASCII filename starting at `offset`. */
function readFilename(names: Buffer, offset: number): string {
  if (offset < 0 || offset >= names.byteLength) {
    throw new Error(
      `TRE name-block offset ${offset} out of range (block size ${names.byteLength})`,
    );
  }
  const end = names.indexOf(0, offset);
  const stop = end < 0 ? names.byteLength : end;
  return names.toString('ascii', offset, stop);
}

/**
 * In-memory TRE archive reader. The constructor parses the header + TOC + name-block
 * and keeps a reference to the archive bytes so per-file reads can be served on demand.
 */
export class TreReader {
  /** All TOC entries in original (crc-sorted) order. Excludes deleted entries (length=0). */
  private readonly entries: ReadonlyArray<TreEntry>;
  /** Parallel CRC-sorted array of indices into `entries` for O(log n) `readByCrc`. */
  private readonly crcSortedIdx: Int32Array;
  /** Lowercase-filename → entry index. Avoids per-lookup CRC computation. */
  private readonly nameIndex: Map<string, number>;
  /** Underlying archive bytes. Sub-buffers reference this without copy. */
  private readonly archive: Buffer;

  private constructor(archive: Buffer, entries: TreEntry[]) {
    this.archive = archive;
    this.entries = entries;

    // Build index for fast lookup; CRC-sorted for binary search by crc.
    this.nameIndex = new Map();
    const order = new Int32Array(entries.length);
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i];
      if (e === undefined) throw new Error('impossible: undefined entry');
      this.nameIndex.set(e.filename, i);
      order[i] = i;
    }
    // Stable sort by crc ascending.
    const idxArray = Array.from(order);
    idxArray.sort((a, b) => {
      const ea = entries[a];
      const eb = entries[b];
      if (ea === undefined || eb === undefined) throw new Error('impossible: undefined entry');
      return ea.crc - eb.crc;
    });
    this.crcSortedIdx = Int32Array.from(idxArray);
  }

  /** Open a TRE archive from a file path (synchronous, reads the entire file). */
  static fromFile(path: string): TreReader {
    return TreReader.fromBytes(readFileSync(path));
  }

  /** Open a TRE archive from an in-memory byte buffer. */
  static fromBytes(bytes: Uint8Array): TreReader {
    const archive = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const header = parseHeader(archive);

    // Decompress TOC + name block. The on-disk order is TOC then name block,
    // both starting at `tocOffset`.
    const tocCompressedEnd = header.tocOffset + header.sizeOfTOC;
    const nameCompressedEnd = tocCompressedEnd + header.sizeOfNameBlock;
    if (nameCompressedEnd > archive.byteLength) {
      throw new Error(
        `TRE metadata extends past end of archive: nameEnd=${nameCompressedEnd}, archive=${archive.byteLength}`,
      );
    }

    const expectedTocSize = header.numberOfFiles * TOC_ENTRY_SIZE;
    const toc = maybeInflate(
      archive.subarray(header.tocOffset, tocCompressedEnd),
      header.tocCompressor,
      expectedTocSize,
    );
    const names = maybeInflate(
      archive.subarray(tocCompressedEnd, nameCompressedEnd),
      header.blockCompressor,
      header.uncompSizeOfNameBlock,
    );

    // Walk the TOC, materialize entries, skipping deleted (length=0) ones.
    const entries: TreEntry[] = [];
    for (let i = 0; i < header.numberOfFiles; i++) {
      const raw = parseTocEntry(toc, i * TOC_ENTRY_SIZE);
      if (raw.length === 0) {
        // Deleted entry — skip. The C++ exists() returns false + sets deleted=true.
        continue;
      }
      const compressor: 0 | 2 = isZlibCompressor(raw.compressor) ? 2 : 0;
      const filename = readFilename(names, raw.fileNameOffset);
      entries.push({
        filename,
        size: raw.length,
        compressedSize: raw.compressedLength,
        compressor,
        offset: raw.fileOffset,
        crc: raw.crc,
      });
    }

    return new TreReader(archive, entries);
  }

  /** Total live entry count (excluding deleted entries). */
  get count(): number {
    return this.entries.length;
  }

  /** All entries; original archive order. */
  list(): ReadonlyArray<TreEntry> {
    return this.entries;
  }

  /** Case-insensitive: input is normalized to lowercase + forward slashes before lookup. */
  exists(filename: string): boolean {
    return this.nameIndex.has(normalizeFilename(filename));
  }

  /**
   * Look up and decompress a file by name. Throws if missing. The returned buffer
   * is a fresh copy and safe to retain.
   */
  read(filename: string): Uint8Array {
    const idx = this.nameIndex.get(normalizeFilename(filename));
    if (idx === undefined) {
      throw new Error(`TRE entry not found: ${JSON.stringify(filename)}`);
    }
    const entry = this.entries[idx];
    if (entry === undefined) throw new Error('impossible: undefined entry');
    return this.readEntry(entry);
  }

  /** Look up by precomputed SOE CRC (for callers that already hashed the filename). */
  readByCrc(crc: number): Uint8Array {
    const idx = this.findByCrc(crc);
    if (idx < 0) {
      throw new Error(`TRE entry not found for crc 0x${(crc >>> 0).toString(16).padStart(8, '0')}`);
    }
    const entry = this.entries[idx];
    if (entry === undefined) throw new Error('impossible: undefined entry');
    return this.readEntry(entry);
  }

  // ---------------------------------------------------------------- internals

  /** Binary search on `crcSortedIdx`; returns `entries` index or -1. */
  private findByCrc(crc: number): number {
    const target = crc >>> 0;
    let left = 0;
    let right = this.crcSortedIdx.length - 1;
    while (left <= right) {
      const mid = (left + right) >>> 1;
      const midIdx = this.crcSortedIdx[mid];
      if (midIdx === undefined) return -1;
      const entry = this.entries[midIdx];
      if (entry === undefined) return -1;
      const midCrc = entry.crc >>> 0;
      if (midCrc < target) left = mid + 1;
      else if (midCrc > target) right = mid - 1;
      else return midIdx;
    }
    return -1;
  }

  private readEntry(entry: TreEntry): Uint8Array {
    const end = entry.offset + entry.compressedSize;
    if (end > this.archive.byteLength) {
      throw new Error(
        `TRE entry ${JSON.stringify(entry.filename)} extends past end of archive ` +
          `(offset=${entry.offset} compressedSize=${entry.compressedSize} archive=${this.archive.byteLength})`,
      );
    }
    const slice = this.archive.subarray(entry.offset, end);
    if (entry.compressor === COMPRESSOR_ZLIB) {
      const out = inflateSync(slice);
      if (out.byteLength !== entry.size) {
        throw new Error(
          `TRE inflate size mismatch for ${JSON.stringify(entry.filename)}: ` +
            `expected ${entry.size}, got ${out.byteLength}`,
        );
      }
      return new Uint8Array(out.buffer, out.byteOffset, out.byteLength);
    }
    // Uncompressed — copy out so the caller can hold past archive lifetime.
    const copy = new Uint8Array(entry.size);
    copy.set(slice);
    return copy;
  }
}

/**
 * Normalize a filename for lookup. Mirrors `CrcString::normalize` from
 * `sharedFoundation/CrcString.cpp` but simplified: we only need lowercase +
 * backslash-to-forward-slash conversion, and consecutive-slash collapsing.
 *
 * The C++ normalization also strips dots after slashes; we mirror that to
 * keep `exists("./foo")` consistent with `exists("foo")`.
 */
export function normalizeFilename(input: string): string {
  let out = '';
  let prevSlash = true;
  for (let i = 0; i < input.length; i++) {
    const c = input.charCodeAt(i);
    // Backslash (0x5C) or forward slash (0x2F)
    if (c === 0x5c || c === 0x2f) {
      if (!prevSlash) {
        out += '/';
        prevSlash = true;
      }
      continue;
    }
    // Dot (0x2E) immediately after slash is dropped; otherwise kept.
    if (c === 0x2e) {
      if (!prevSlash) {
        out += '.';
      }
      continue;
    }
    // Lowercase ASCII A-Z (0x41..0x5A) → 0x61..0x7A
    if (c >= 0x41 && c <= 0x5a) {
      out += String.fromCharCode(c + 0x20);
    } else {
      out += input[i];
    }
    prevSlash = false;
  }
  return out;
}

/** Re-export so callers can hash a filename without importing the helper directly. */
export { treFilenameCrc };
