/**
 * TRE (SOE TreeFile) archive WRITER.
 *
 * Builds a fresh `.tre` archive from a programmatically-added list of
 * (filename, bytes) pairs. The output is bit-compatible with what the
 * Windows client + server consume — round-trip the produced archive
 * through `TreReader` to verify.
 *
 * Output layout (all integers little-endian):
 *   [36-byte header][file data 1..N][TOC, optionally zlib][name block, optionally zlib]
 *
 * The header points the TOC at `tocOffset = HEADER_SIZE + sum(per-file on-disk bytes)`.
 * Per-file compression is independent — each `add()` call may opt in or out.
 *
 * Files are sorted by SOE CRC32 of the (lowercase, forward-slash-normalized)
 * filename so the reader's binary search works.
 *
 * Version: emits 0005 (current). 0004 is also a valid version tag but the
 * layout is identical for this writer's purposes.
 */

import { Buffer } from 'node:buffer';
import { deflateSync } from 'node:zlib';
import { treFilenameCrc } from './tre-crc.js';
import { normalizeFilename } from './tre-reader.js';

const HEADER_SIZE = 36;
const TOC_ENTRY_SIZE = 24;
const TAG_TREE = 0x54524545;
const TAG_0005 = 0x30303035;
const COMPRESSOR_NONE = 0;
const COMPRESSOR_ZLIB = 2;

interface PendingEntry {
  /** Lowercase, forward-slash-normalized filename. */
  readonly filename: string;
  /** Filename's SOE CRC. */
  readonly crc: number;
  /** Uncompressed byte length. */
  readonly size: number;
  /** Bytes to write to disk (zlib-deflated when compressor === 2; raw otherwise). */
  readonly onDiskBytes: Buffer;
  /** 0 = none, 2 = zlib. */
  readonly compressor: 0 | 2;
}

/** Options for an individual `add()` call. */
export interface TreAddOptions {
  /** Pass false to skip per-file zlib (default: true). Set false for already-compressed
   *  payloads like PNG / OGG to avoid wasting CPU on negligible size gains. */
  compress?: boolean;
}

/** Options for `toBytes()` controlling whether the TOC + name block are deflated. */
export interface TreBuildOptions {
  /** Zlib-deflate the TOC (default: true). */
  tocCompress?: boolean;
  /** Zlib-deflate the name block (default: true). */
  nameBlockCompress?: boolean;
}

export class TreWriter {
  private readonly entries: PendingEntry[] = [];
  private readonly seenNames = new Set<string>();

  /**
   * Add a file to the archive. Filenames are normalized to lowercase + forward
   * slashes. Duplicate filenames (after normalization) throw. Zero-byte payloads
   * are rejected because the on-disk format uses length=0 as a tombstone for
   * deleted entries — see `TreeFile_SearchNode.cpp:397-400`.
   */
  add(filename: string, bytes: Uint8Array, opts: TreAddOptions = {}): this {
    const normalized = normalizeFilename(filename);
    if (normalized.length === 0) {
      throw new Error(
        `TRE filename cannot be empty after normalization (input: ${JSON.stringify(filename)})`,
      );
    }
    if (this.seenNames.has(normalized)) {
      throw new Error(`TRE duplicate filename: ${JSON.stringify(normalized)}`);
    }
    if (bytes.byteLength === 0) {
      throw new Error(
        `TRE empty payload for ${JSON.stringify(normalized)} — zero-byte entries collide with the deleted-entry tombstone (length=0)`,
      );
    }
    this.seenNames.add(normalized);

    // Wrap whatever the caller handed us so the Buffer.from(input)/deflateSync path is uniform.
    const raw = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);

    const wantCompress = opts.compress ?? true;
    let onDisk: Buffer;
    let compressor: 0 | 2;
    if (wantCompress && raw.byteLength > 0) {
      const deflated = deflateSync(raw);
      // Only keep the compressed form if it actually saves space (matches the
      // C++ tool's behavior — there's no point paying inflate cost for a larger result).
      if (deflated.byteLength < raw.byteLength) {
        onDisk = deflated;
        compressor = 2;
      } else {
        onDisk = raw;
        compressor = 0;
      }
    } else {
      onDisk = raw;
      compressor = 0;
    }

    this.entries.push({
      filename: normalized,
      crc: treFilenameCrc(normalized),
      size: raw.byteLength,
      onDiskBytes: onDisk,
      compressor,
    });
    return this;
  }

  /** Number of entries currently staged. */
  get count(): number {
    return this.entries.length;
  }

  /**
   * Assemble the archive. Sorts entries by filename CRC, builds the file-data
   * region, then the TOC + name block (optionally deflated), then prepends the
   * header.
   */
  toBytes(opts: TreBuildOptions = {}): Uint8Array {
    const tocCompress = opts.tocCompress ?? true;
    const nameBlockCompress = opts.nameBlockCompress ?? true;

    // Sort entries by CRC ascending so the reader's binary search succeeds.
    // CRC collisions are theoretically possible but vanishingly rare for real
    // filename inputs; we don't apply a secondary tiebreaker (the C++ reader
    // falls back to strcmp on collision, which would require duplicate-crc
    // entries to be sorted by filename — outside our scope).
    const sorted = [...this.entries].sort((a, b) => (a.crc >>> 0) - (b.crc >>> 0));

    // --- 1. File data region ---
    // For each entry: assign offset = current write cursor, then concatenate
    // the on-disk bytes. The TOC needs the assigned offset.
    let dataCursor = HEADER_SIZE;
    const entryOffsets: number[] = [];
    for (const e of sorted) {
      entryOffsets.push(dataCursor);
      dataCursor += e.onDiskBytes.byteLength;
    }
    const tocOffset = dataCursor;

    // --- 2. Name block (uncompressed) ---
    // For each entry: assign nameBlockOffset = current name-block cursor, then
    // append the filename bytes + a trailing NUL.
    let nameCursor = 0;
    const nameOffsets: number[] = [];
    const nameBlockParts: Buffer[] = [];
    for (const e of sorted) {
      nameOffsets.push(nameCursor);
      const nameBytes = Buffer.from(e.filename, 'ascii');
      nameBlockParts.push(nameBytes);
      nameBlockParts.push(Buffer.from([0])); // NUL terminator
      nameCursor += nameBytes.byteLength + 1;
    }
    const nameBlockUncompressed = Buffer.concat(nameBlockParts, nameCursor);

    // --- 3. TOC (uncompressed) ---
    const tocUncompressed = Buffer.alloc(sorted.length * TOC_ENTRY_SIZE);
    for (let i = 0; i < sorted.length; i++) {
      const e = sorted[i];
      const off = entryOffsets[i];
      const nameOff = nameOffsets[i];
      if (e === undefined || off === undefined || nameOff === undefined) {
        throw new Error('impossible: sorted entry index out of range');
      }
      const base = i * TOC_ENTRY_SIZE;
      tocUncompressed.writeUInt32LE(e.crc >>> 0, base);
      tocUncompressed.writeInt32LE(e.size, base + 4);
      tocUncompressed.writeInt32LE(off, base + 8);
      tocUncompressed.writeInt32LE(e.compressor, base + 12);
      tocUncompressed.writeInt32LE(e.onDiskBytes.byteLength, base + 16);
      tocUncompressed.writeInt32LE(nameOff, base + 20);
    }

    // --- 4. Optionally deflate TOC and name block ---
    let tocOnDisk: Buffer = tocUncompressed;
    let tocCompressor: number = COMPRESSOR_NONE;
    if (tocCompress && tocUncompressed.byteLength > 0) {
      tocOnDisk = deflateSync(tocUncompressed);
      tocCompressor = COMPRESSOR_ZLIB;
    }
    let nameOnDisk: Buffer = nameBlockUncompressed;
    let nameCompressor: number = COMPRESSOR_NONE;
    if (nameBlockCompress && nameBlockUncompressed.byteLength > 0) {
      nameOnDisk = deflateSync(nameBlockUncompressed);
      nameCompressor = COMPRESSOR_ZLIB;
    }

    // --- 5. Header ---
    // Tags are conceptually built as ('T'<<24)|('R'<<16)|('E'<<8)|'E' = 0x54524545,
    // then stored as native uint32 — which on x86/LE means the bytes appear as "EERT"
    // on disk. So we write LE here even though the bytes spell "TREE" backwards.
    const header = Buffer.alloc(HEADER_SIZE);
    header.writeUInt32LE(TAG_TREE, 0);
    header.writeUInt32LE(TAG_0005, 4);
    header.writeUInt32LE(sorted.length, 8);
    header.writeUInt32LE(tocOffset, 12);
    header.writeUInt32LE(tocCompressor, 16);
    header.writeUInt32LE(tocOnDisk.byteLength, 20);
    header.writeUInt32LE(nameCompressor, 24);
    header.writeUInt32LE(nameOnDisk.byteLength, 28);
    header.writeUInt32LE(nameBlockUncompressed.byteLength, 32);

    // --- 6. Assemble final archive ---
    const totalSize =
      HEADER_SIZE +
      sorted.reduce((sum, e) => sum + e.onDiskBytes.byteLength, 0) +
      tocOnDisk.byteLength +
      nameOnDisk.byteLength;
    const out = Buffer.alloc(totalSize);
    header.copy(out, 0);
    let cursor = HEADER_SIZE;
    for (const e of sorted) {
      e.onDiskBytes.copy(out, cursor);
      cursor += e.onDiskBytes.byteLength;
    }
    tocOnDisk.copy(out, cursor);
    cursor += tocOnDisk.byteLength;
    nameOnDisk.copy(out, cursor);
    cursor += nameOnDisk.byteLength;
    if (cursor !== totalSize) {
      throw new Error(`TRE write size mismatch: cursor=${cursor} totalSize=${totalSize}`);
    }
    return new Uint8Array(out.buffer, out.byteOffset, out.byteLength);
  }
}
