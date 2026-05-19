/**
 * `CrcStringTable` IFF reader — the canonical SWG CRC → string lookup.
 *
 * # Why this exists
 *
 * Buildout objects (the cantina, every static building, every NPC spawner
 * the world ships with) arrive over the wire via `SceneCreateObjectByCrc`,
 * which carries ONLY the template CRC. The friendlier `SceneCreateObjectByName`
 * is used for dynamically-spawned objects. So a building observed in the
 * WorldModel has `templateCrc` set and `templateName` undefined, which means
 * `ctx.navigate({ buildingId, cellName })` can't feed `BuildingKB.templateInfoFor`
 * to resolve the `.pob` portal-layout filename → can't walk a player into
 * the building.
 *
 * `object_template_crc_string_table.iff` (~30k entries, ~2 MB) is the SWG
 * client's canonical CRC → template-name index. Loading it once + binary
 * search per lookup is fast (O(log 30k) = 15 comparisons), and the result
 * lets `navigate.ts` recover the templateName for any buildout object.
 *
 * # Wire format (verified against C++ ground truth)
 *
 * `~/code/swg-main/src/engine/shared/library/sharedFoundation/src/shared/CrcStringTable.cpp:90-138`:
 *
 *     FORM CSTB
 *       FORM 0000
 *         DATA chunk    [int32 numEntries]
 *         CRCT chunk    [uint32 LE × numEntries]    — sorted ascending
 *         STRT chunk    [int32 LE × numEntries]      — byte offset into STNG
 *         STNG chunk    [raw bytes]                  — null-terminated string blob
 *
 * The CRC table is sorted ascending (the C++ uses binary search at runtime;
 * `CrcStringTable.cpp:149-168` shows the loop). The string blob is a single
 * contiguous run of NUL-terminated C strings; each `STRT` entry is the byte
 * offset of one string into that blob.
 *
 * The CRC algorithm is `Crc::calculate` — the SAME custom 256-entry-table
 * CRC32 variant used elsewhere in SWG (NOT zlib's polynomial). We already
 * implement it as `constcrc()` in `src/crc/constcrc.ts`.
 *
 * # Public API
 *
 *   - `parseCrcStringTable(bytes, sourceName?)` — pure, synchronous.
 *   - `loadCrcStringTable(filename)` — async loader that resolves bytes
 *     through the same asset-resolution chain as `loadPortalLayout`.
 *
 * Both throw with a contextual message on malformed input.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Iff } from './iff.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Reverse-lookup table from 32-bit `Crc::calculate` value to template-name
 * string. Strings are stored as a single contiguous byte blob and decoded
 * lazily on lookup hits (avoids decoding 30k entries when we only need a
 * handful per session).
 */
export interface CrcStringTable {
  /**
   * Look up a template name by its 32-bit CRC. Returns `null` if the CRC
   * isn't in the table.
   *
   * Performs a binary search over the sorted CRC index (O(log n) — for a
   * ~30k-entry table that's ~15 comparisons). Compares as UNSIGNED uint32
   * — the C++ stores CRCs as `uint32` and the table is sorted by unsigned
   * value, so signed comparison would mis-bisect at the high half.
   */
  lookup(crc: number): string | null;

  /** Total entries in the table (diagnostic only). */
  size(): number;

  /**
   * All entries (diagnostic only). DO NOT call this in hot paths — it
   * decodes every string in the blob (~30k for the canonical file).
   */
  entries(): IterableIterator<{ crc: number; name: string }>;
}

// ---------------------------------------------------------------------------
// Public functions
// ---------------------------------------------------------------------------

/**
 * Parse a `CrcStringTable` IFF (`*_crc_string_table.iff`) from raw bytes.
 * Pure; no I/O.
 *
 * Throws if the bytes aren't a valid `FORM CSTB / FORM 0000` envelope, or
 * if the chunk shapes don't match the wire spec.
 *
 * `sourceName` is stamped onto error messages so multi-file diagnostics
 * stay clear.
 */
export function parseCrcStringTable(bytes: Uint8Array, sourceName = '<bytes>'): CrcStringTable {
  const iff = Iff.fromBytes(bytes, sourceName);

  iff.enterForm('CSTB');
  // Only version `0000` is known. The C++ asserts on anything else.
  const version = iff.enterAnyForm();
  if (version !== '0000') {
    throw new Error(
      `parseCrcStringTable[${sourceName}]: unsupported CSTB version '${version}' (only '0000' known)`,
    );
  }

  iff.enterChunk('DATA');
  const numEntries = iff.readI32();
  iff.exitChunk('DATA');

  if (numEntries < 0) {
    throw new Error(`parseCrcStringTable[${sourceName}]: negative numEntries=${numEntries}`);
  }

  iff.enterChunk('CRCT');
  const crctBytes = iff.getChunkLengthTotal();
  const expectedCrctBytes = numEntries * 4;
  if (crctBytes !== expectedCrctBytes) {
    throw new Error(
      `parseCrcStringTable[${sourceName}]: CRCT chunk length ${crctBytes} != expected ${expectedCrctBytes} (numEntries=${numEntries})`,
    );
  }
  const crcs = new Uint32Array(numEntries);
  for (let i = 0; i < numEntries; ++i) {
    crcs[i] = iff.readU32();
  }
  iff.exitChunk('CRCT');

  iff.enterChunk('STRT');
  const strtBytes = iff.getChunkLengthTotal();
  const expectedStrtBytes = numEntries * 4;
  if (strtBytes !== expectedStrtBytes) {
    throw new Error(
      `parseCrcStringTable[${sourceName}]: STRT chunk length ${strtBytes} != expected ${expectedStrtBytes}`,
    );
  }
  const offsets = new Int32Array(numEntries);
  for (let i = 0; i < numEntries; ++i) {
    offsets[i] = iff.readI32();
  }
  iff.exitChunk('STRT');

  iff.enterChunk('STNG');
  const stngBytes = iff.getChunkLengthTotal();
  // Take a copy so the returned table holds its own buffer (the IFF reader
  // may be backed by a larger source buffer we don't want to retain).
  const stng = iff.readBytes(stngBytes);
  iff.exitChunk('STNG');

  iff.exitForm(version);
  iff.exitForm('CSTB');

  return new CrcStringTableImpl(crcs, offsets, stng, numEntries);
}

/**
 * Async loader: resolve `*_crc_string_table.iff` (typically
 * `'misc/object_template_crc_string_table.iff'`) to a parsed `CrcStringTable`.
 *
 * Resolution priority (matches `loadPortalLayout`):
 *   1. `<cwd>/assets/<filename>`
 *   2. `<cwd>/../swg-main/serverdata/<filename>`
 *   3. `<cwd>/../swg-main/data/sku.0/sys.client/built/game/<filename>`
 *   4. The configured TRE archive entry `<filename>`
 *
 * Throws (or returns a rejecting promise) on file-not-found, malformed
 * bytes, or unsupported version.
 */
export async function loadCrcStringTable(filename: string): Promise<CrcStringTable> {
  const bytes = await defaultLoadFile(filename);
  return parseCrcStringTable(bytes, filename);
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/**
 * Concrete `CrcStringTable` implementation. Holds the three parallel arrays
 * + the raw string blob; `lookup` does binary search + lazy NUL-terminated
 * string decode on hits only.
 */
class CrcStringTableImpl implements CrcStringTable {
  constructor(
    private readonly crcs: Uint32Array,
    private readonly offsets: Int32Array,
    private readonly stng: Uint8Array,
    private readonly numEntries: number,
  ) {}

  lookup(crc: number): string | null {
    // Compare as UNSIGNED. JavaScript's `<` on numbers obeys IEEE-754 and
    // for non-negative integers in [0, 2^32) it behaves identically to
    // unsigned. We force unsigned interpretation via `>>> 0` on both sides
    // so callers passing a sign-extended int32 (e.g. `0xff80abcd|0`) still
    // bisect correctly.
    const target = crc >>> 0;
    let lo = 0;
    let hi = this.numEntries - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >>> 1;
      const v = this.crcs[mid];
      if (v === undefined) {
        // Unreachable given the bounds, but `noUncheckedIndexedAccess`
        // insists. Treat as "not found" rather than throwing — a corrupt
        // table is no reason to crash the navigate path.
        return null;
      }
      const entry = v >>> 0;
      if (entry === target) {
        return this.decodeStringAt(mid);
      }
      if (target > entry) {
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    return null;
  }

  size(): number {
    return this.numEntries;
  }

  *entries(): IterableIterator<{ crc: number; name: string }> {
    for (let i = 0; i < this.numEntries; ++i) {
      const v = this.crcs[i];
      if (v === undefined) continue;
      const name = this.decodeStringAt(i);
      if (name === null) continue;
      yield { crc: v >>> 0, name };
    }
  }

  /**
   * Decode the NUL-terminated string at entry `i` of the table. Returns
   * `null` if the offset points out of the STNG blob or no NUL terminator
   * is found before end-of-blob (corrupt index).
   */
  private decodeStringAt(i: number): string | null {
    const off = this.offsets[i];
    if (off === undefined) return null;
    if (off < 0 || off >= this.stng.length) return null;
    let end = off;
    while (end < this.stng.length && this.stng[end] !== 0) {
      end += 1;
    }
    if (end >= this.stng.length) {
      // Missing terminator — corrupt index.
      return null;
    }
    return decodeLatin1(this.stng, off, end);
  }
}

/**
 * Decode a byte range as Latin-1 (each byte → its Unicode code point).
 * Template names are all ASCII in practice; this is just defensive about
 * any stray high-byte content.
 */
function decodeLatin1(data: Uint8Array, start: number, end: number): string {
  let out = '';
  for (let i = start; i < end; ++i) {
    const b = data[i];
    if (b === undefined) {
      // Unreachable given start/end are inside the array, but the type
      // system can't tell.
      throw new RangeError(`CrcStringTable: out-of-range byte at offset ${i}`);
    }
    out += String.fromCharCode(b);
  }
  return out;
}

/**
 * Default asset loader. Walks the same priority chain `loadPortalLayout`
 * uses, plus the client-built tree where the file commonly lives, plus
 * a `$HOME/code/swg-main/...` fallback so the loader works from `.claude`
 * worktrees whose `<cwd>/..` doesn't reach the swg-main tree:
 *
 *   1. extracted-on-disk under `<cwd>/assets/<filename>`
 *   2. extracted-on-disk under `<cwd>/../swg-main/serverdata/<filename>`
 *   3. extracted-on-disk under `<cwd>/../swg-main/data/sku.0/sys.client/built/game/<filename>`
 *      (the canonical client-built location for *_crc_string_table.iff)
 *   4. `$SWG_MAIN_DIR/serverdata/<filename>` and the client-built variant
 *   5. `$HOME/code/swg-main/serverdata/<filename>` and the client-built variant
 *   6. the TRE archive entry — best effort
 *
 * The non-cwd-relative fallbacks (4-5) exist because the entertainer-bot
 * and live tests sometimes run from `.claude/worktrees/agent-XXX/` where
 * `<cwd>/..` lands several levels above `swg-main`.
 */
async function defaultLoadFile(filename: string): Promise<Uint8Array> {
  for (const candidate of resolveCandidatePaths(filename)) {
    if (existsSync(candidate)) return readFileSync(candidate);
  }

  try {
    const { getTreReader, resolveDefaultTrePath } = await import('../terrain/asset-loader.js');
    const trePath = resolveDefaultTrePath();
    const reader = getTreReader(trePath);
    if (reader.exists(filename)) {
      return reader.read(filename);
    }
  } catch {
    // No TRE configured. Fall through to the throw below.
  }

  throw new Error(`loadCrcStringTable: no asset found for '${filename}'`);
}

/**
 * Yield the candidate filesystem paths for `filename`, in priority order.
 * Exported as a helper so the loader and any diagnostics share a single
 * source of truth.
 */
function resolveCandidatePaths(filename: string): string[] {
  const home = process.env.HOME ?? '';
  const explicit = process.env.SWG_MAIN_DIR ?? '';
  const candidates: string[] = [
    // 1. Local assets/ stash (highest priority — the project's own staging).
    join(process.cwd(), 'assets', filename),
    // 2-3. Sibling checkout (canonical layout in the main repo).
    join(process.cwd(), '..', 'swg-main', 'serverdata', filename),
    join(process.cwd(), '..', 'swg-main', 'data', 'sku.0', 'sys.client', 'built', 'game', filename),
  ];
  // 4. SWG_MAIN_DIR env override (so users can run from anywhere).
  if (explicit !== '') {
    candidates.push(join(explicit, 'serverdata', filename));
    candidates.push(join(explicit, 'data', 'sku.0', 'sys.client', 'built', 'game', filename));
  }
  // 5. $HOME/code/swg-main fallback — covers `.claude/worktrees/` runs.
  if (home !== '') {
    candidates.push(join(home, 'code', 'swg-main', 'serverdata', filename));
    candidates.push(
      join(home, 'code', 'swg-main', 'data', 'sku.0', 'sys.client', 'built', 'game', filename),
    );
  }
  return candidates;
}
