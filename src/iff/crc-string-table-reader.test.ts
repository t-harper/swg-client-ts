/**
 * Tests for `parseCrcStringTable` — the CSTB IFF reader.
 *
 * Two layers of coverage:
 *
 *   1. **Round-trip via `IffWriter`** — programmatically build a small
 *      (~3-entry) CSTB blob, parse it back, assert every known CRC resolves
 *      to its expected string and an unknown CRC returns `null`. This is
 *      the filesystem-free regression guard.
 *
 *   2. **Optional fixture-based test** against the real
 *      `object_template_crc_string_table.iff` from `~/code/swg-main` IF
 *      present on disk. Gated by `describe.skipIf` on file existence so CI
 *      without the swg-main checkout still runs the round-trip suite.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { constcrc } from '../crc/constcrc.js';
import { parseCrcStringTable } from './crc-string-table-reader.js';
import { IffWriter } from './iff.js';

/**
 * Build a tiny CSTB blob from `entries`. Mirrors the on-disk format used
 * by `CrcStringTable.cpp:114-138`:
 *
 *     FORM CSTB
 *       FORM 0000
 *         DATA  [int32 numEntries]
 *         CRCT  [uint32 × numEntries, sorted ascending]
 *         STRT  [int32 × numEntries — offset into STNG]
 *         STNG  [raw NUL-terminated strings]
 *
 * The entries are sorted by CRC inside this helper so callers can pass them
 * in any order — keeps the test data readable.
 */
function buildCrcStringTable(entries: { crc: number; name: string }[]): Uint8Array {
  // Sort by unsigned CRC ascending — matches what the C++ exporter does.
  const sorted = [...entries].sort((a, b) => (a.crc >>> 0) - (b.crc >>> 0));

  // Layout the STNG blob: each string back-to-back, NUL-terminated.
  const stngChunks: number[] = [];
  const offsets: number[] = [];
  for (const e of sorted) {
    offsets.push(stngChunks.length);
    for (let i = 0; i < e.name.length; ++i) {
      stngChunks.push(e.name.charCodeAt(i) & 0xff);
    }
    stngChunks.push(0);
  }
  const stngBytes = new Uint8Array(stngChunks);

  const w = new IffWriter()
    .insertForm('CSTB')
    .insertForm('0000')
    .insertChunk('DATA')
    .writeI32(sorted.length)
    .exitChunk();
  w.insertChunk('CRCT');
  for (const e of sorted) w.writeU32(e.crc >>> 0);
  w.exitChunk();
  w.insertChunk('STRT');
  for (const off of offsets) w.writeI32(off);
  w.exitChunk();
  w.insertChunk('STNG');
  w.writeBytes(stngBytes);
  w.exitChunk();
  w.exitForm();
  w.exitForm();
  return w.toBytes();
}

describe('parseCrcStringTable — round-trip via IffWriter', () => {
  it('parses a 3-entry table and looks up each entry by CRC', () => {
    const entries = [
      {
        crc: constcrc('object/building/tatooine/shared_cantina_tatooine.iff'),
        name: 'object/building/tatooine/shared_cantina_tatooine.iff',
      },
      {
        crc: constcrc('object/creature/player/human_male.iff'),
        name: 'object/creature/player/human_male.iff',
      },
      {
        crc: constcrc('appearance/thm_tato_cantina.pob'),
        name: 'appearance/thm_tato_cantina.pob',
      },
    ];
    const bytes = buildCrcStringTable(entries);
    const table = parseCrcStringTable(bytes, 'fixture');

    expect(table.size()).toBe(3);
    for (const e of entries) {
      expect(table.lookup(e.crc), `lookup(0x${e.crc.toString(16)})`).toBe(e.name);
    }
  });

  it('returns null for an unknown CRC', () => {
    const entries = [
      {
        crc: constcrc('object/building/tatooine/shared_cantina_tatooine.iff'),
        name: 'object/building/tatooine/shared_cantina_tatooine.iff',
      },
    ];
    const bytes = buildCrcStringTable(entries);
    const table = parseCrcStringTable(bytes, 'fixture');

    expect(table.lookup(0xdeadbeef)).toBeNull();
    expect(table.lookup(0)).toBeNull();
  });

  it('binary search still works for entries near the top of the unsigned range', () => {
    // High-bit-set CRCs are common (~half the table); ensure the lookup
    // doesn't mis-bisect by treating them as signed.
    const entries = [
      { crc: 0x00010002, name: 'low/entry.iff' },
      { crc: 0x7fffffff, name: 'middle/entry.iff' },
      { crc: 0x80000000, name: 'cusp/entry.iff' },
      { crc: 0xffffffff, name: 'high/entry.iff' },
    ];
    const bytes = buildCrcStringTable(entries);
    const table = parseCrcStringTable(bytes, 'high-bit');

    expect(table.lookup(0x80000000)).toBe('cusp/entry.iff');
    expect(table.lookup(0xffffffff)).toBe('high/entry.iff');
    expect(table.lookup(0x00010002)).toBe('low/entry.iff');
    expect(table.lookup(0x7fffffff)).toBe('middle/entry.iff');
  });

  it('handles an empty table', () => {
    const bytes = buildCrcStringTable([]);
    const table = parseCrcStringTable(bytes, 'empty');
    expect(table.size()).toBe(0);
    expect(table.lookup(0x12345678)).toBeNull();
    expect([...table.entries()]).toEqual([]);
  });

  it('entries() iterator yields every entry in stored order', () => {
    const entries = [
      { crc: constcrc('a.iff'), name: 'a.iff' },
      { crc: constcrc('b.iff'), name: 'b.iff' },
      { crc: constcrc('c.iff'), name: 'c.iff' },
    ];
    const bytes = buildCrcStringTable(entries);
    const table = parseCrcStringTable(bytes, 'iter');

    const yielded = [...table.entries()];
    expect(yielded).toHaveLength(3);
    // Order follows CRC-ascending (the sort that buildCrcStringTable applied);
    // we just check the set of (crc, name) round-trips correctly.
    const yieldedSet = new Set(yielded.map((e) => `${e.crc.toString(16)}=${e.name}`));
    for (const e of entries) {
      expect(yieldedSet.has(`${(e.crc >>> 0).toString(16)}=${e.name}`)).toBe(true);
    }
  });

  it('rejects an unsupported version', () => {
    // Build a CSTB with a `0001` version sub-FORM instead of `0000`.
    const w = new IffWriter().insertForm('CSTB').insertForm('0001').insertChunk('DATA').writeI32(0);
    w.exitChunk();
    w.exitForm();
    w.exitForm();
    const bytes = w.toBytes();
    expect(() => parseCrcStringTable(bytes, 'badver')).toThrow(/unsupported CSTB version/);
  });
});

// ---------------------------------------------------------------------------
// Optional fixture-based test against the real swg-main file.
// ---------------------------------------------------------------------------
//
// Same `describe.skipIf` pattern as `portal-layout-reader.test.ts`: gated on
// file existence so CI without a swg-main checkout still runs the round-trip
// tests above. When present, exercises the actual ~2 MB / 30k-entry table
// to guarantee the parser hasn't drifted from real-world wire bytes.

// Candidate locations for the real `object_template_crc_string_table.iff`:
//   - the canonical sibling-checkout layout (`<cwd>/../swg-main/...`) used by
//     the test runner in the main repo; and
//   - the absolute path under `~/code/swg-main/...` for worktrees whose
//     `cwd/..` doesn't reach the swg-main tree.
// Both are best-effort; the round-trip test above is the authoritative
// regression guard and runs everywhere.
const HOME = process.env.HOME ?? '';
const REAL_FILE_CANDIDATES = [
  join(
    process.cwd(),
    '..',
    'swg-main',
    'serverdata',
    'misc',
    'object_template_crc_string_table.iff',
  ),
  join(
    process.cwd(),
    '..',
    'swg-main',
    'data',
    'sku.0',
    'sys.client',
    'built',
    'game',
    'misc',
    'object_template_crc_string_table.iff',
  ),
  join(HOME, 'code', 'swg-main', 'serverdata', 'misc', 'object_template_crc_string_table.iff'),
];
const realFile = REAL_FILE_CANDIDATES.find((p) => existsSync(p)) ?? null;

describe.skipIf(realFile === null)('parseCrcStringTable — swg-main fixture', () => {
  it('parses the real object_template_crc_string_table.iff and resolves the cantina', async () => {
    // Lazy-load so the test never fails to import when the fixture is
    // missing (describe.skipIf still requires the body to be syntactically
    // valid — but we avoid the readFileSync until we're actually running).
    const { readFileSync } = await import('node:fs');
    // `realFile` is non-null inside this describe (skipIf above), but the
    // type-narrow doesn't carry through; assign to a local with a guard so
    // we stay clear of non-null assertions.
    const path = realFile;
    if (path === null) throw new Error('unreachable: skipIf gates this describe');
    const bytes = readFileSync(path);
    const table = parseCrcStringTable(bytes, path);

    // 29k–30k entries — exact count varies by swg-main version, but it
    // must be in this range, anything smaller means we mis-read DATA.
    expect(table.size()).toBeGreaterThan(20_000);
    expect(table.size()).toBeLessThan(50_000);

    // The cantina is the load-bearing lookup the navigate path needs.
    const cantinaCrc = constcrc('object/building/tatooine/shared_cantina_tatooine.iff');
    expect(table.lookup(cantinaCrc)).toBe('object/building/tatooine/shared_cantina_tatooine.iff');

    // An unknown CRC must return null — confirms the binary search
    // terminates cleanly when nothing matches.
    expect(table.lookup(0xdeadbeef)).toBeNull();
  });
});
