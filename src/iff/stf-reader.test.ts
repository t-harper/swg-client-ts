/**
 * Tests for the `.stf` localized-string-table reader.
 *
 * Strategy:
 *   - Golden-byte tests against bytes constructed in-test (so the spec is
 *     visible right next to the assertions).
 *   - Real on-disk fixtures (`tests/fixtures/stf-*.stf`) copied verbatim
 *     from `~/code/swg-main/serverdata/string/`. Verified via `xxd` before
 *     commit; not hand-crafted.
 *   - Negative cases (bad magic, bad version, truncated chunks) to catch
 *     "we threw" vs "we silently misparsed" regressions.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseStf } from './stf-reader.js';

const FIXTURE_DIR = join(process.cwd(), 'tests', 'fixtures');

/**
 * Build a 1-entry `.stf` programmatically. Mirrors the byte layout
 * documented in `stf-reader.ts`:
 *   header: `[u32 LE 0xabcd][u8 version]`
 *   table header: `[u32 LE nextUniqueId][u32 LE numEntries]`
 *   string record: `[u32 LE id][u32 LE crc][u32 LE wideLen][wideLen * u16 LE]`
 *   name record: `[u32 LE id][u32 LE narrowLen][narrowLen bytes ASCII]`
 */
function buildStf(opts: {
  version?: number;
  nextUniqueId?: number;
  /** Insertion order matters — preserved on-disk and in the returned Map. */
  entries: ReadonlyArray<{ id: number; key: string; value: string; crc?: number }>;
}): Uint8Array {
  const version = opts.version ?? 1;
  const nextUniqueId = opts.nextUniqueId ?? opts.entries.length + 1;
  const wideBytes = opts.entries.reduce((acc, e) => acc + 12 + e.value.length * 2, 0);
  const narrowBytes = opts.entries.reduce((acc, e) => acc + 8 + e.key.length, 0);
  const total = 5 + 8 + wideBytes + narrowBytes;

  const buf = new Uint8Array(total);
  const view = new DataView(buf.buffer);
  let off = 0;
  view.setUint32(off, 0xabcd, true);
  off += 4;
  view.setUint8(off, version);
  off += 1;
  view.setUint32(off, nextUniqueId, true);
  off += 4;
  view.setUint32(off, opts.entries.length, true);
  off += 4;

  for (const e of opts.entries) {
    view.setUint32(off, e.id, true);
    off += 4;
    view.setUint32(off, e.crc ?? 0xffffffff, true);
    off += 4;
    view.setUint32(off, e.value.length, true);
    off += 4;
    for (let i = 0; i < e.value.length; ++i) {
      view.setUint16(off, e.value.charCodeAt(i), true);
      off += 2;
    }
  }

  for (const e of opts.entries) {
    view.setUint32(off, e.id, true);
    off += 4;
    view.setUint32(off, e.key.length, true);
    off += 4;
    for (let i = 0; i < e.key.length; ++i) {
      view.setUint8(off, e.key.charCodeAt(i));
      off += 1;
    }
  }

  return buf;
}

describe('parseStf — programmatic round-trips', () => {
  it('parses a 1-entry table (default → "hair") byte-for-byte', () => {
    // The exact byte sequence below matches the on-disk
    // `string/en/hair_lookat.stf` produced by the SWG content build.
    // Decoded:
    //   header: cd ab 00 00 | 01 (version)
    //   table:  02 00 00 00 (nextUniqueId=2) | 01 00 00 00 (numEntries=1)
    //   str#1:  01 00 00 00 (id=1) | ff ff ff ff (crc=0xffffffff) |
    //           04 00 00 00 (wideLen=4) | 68 00 61 00 69 00 72 00 ('hair' UTF-16 LE)
    //   name#1: 01 00 00 00 (id=1) | 07 00 00 00 (len=7) | 64 65 66 61 75 6c 74 ('default')
    const expected = new Uint8Array([
      0xcd, 0xab, 0x00, 0x00, 0x01, 0x02, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x00,
      0x00, 0x00, 0xff, 0xff, 0xff, 0xff, 0x04, 0x00, 0x00, 0x00, 0x68, 0x00, 0x61, 0x00, 0x69,
      0x00, 0x72, 0x00, 0x01, 0x00, 0x00, 0x00, 0x07, 0x00, 0x00, 0x00, 0x64, 0x65, 0x66, 0x61,
      0x75, 0x6c, 0x74,
    ]);

    const built = buildStf({
      version: 1,
      nextUniqueId: 2,
      entries: [{ id: 1, key: 'default', value: 'hair' }],
    });
    expect(built).toEqual(expected);

    const table = parseStf(expected);
    expect(table.language).toBe('');
    expect(table.entries.size).toBe(1);
    expect(table.entries.get('default')).toBe('hair');
  });

  it('parses a 3-entry ASCII table preserving on-disk key order', () => {
    // Same shape as on-disk `string/en/pvp_factions.stf`: ids 1,2,3 in the
    // string table, but the name table is keyed by std::map<string,id> so
    // the keys come out alphabetically — "imperial" / "neutral" / "rebel".
    // We build the bytes by hand rather than via `buildStf` so the
    // string-table vs name-table ids can be ordered independently — a path
    // the helper can't exercise.
    const stringRecords = [
      { id: 1, value: 'Neutral' },
      { id: 2, value: 'Imperial' },
      { id: 3, value: 'Rebel' },
    ];
    const nameRecords = [
      { id: 2, key: 'imperial' },
      { id: 1, key: 'neutral' },
      { id: 3, key: 'rebel' },
    ];
    const wideBytes = stringRecords.reduce((a, r) => a + 12 + r.value.length * 2, 0);
    const narrowBytes = nameRecords.reduce((a, r) => a + 8 + r.key.length, 0);
    const out = new Uint8Array(5 + 8 + wideBytes + narrowBytes);
    const view = new DataView(out.buffer);
    let off = 0;
    view.setUint32(off, 0xabcd, true);
    off += 4;
    view.setUint8(off, 1);
    off += 1;
    view.setUint32(off, 4, true);
    off += 4;
    view.setUint32(off, 3, true);
    off += 4;
    for (const r of stringRecords) {
      view.setUint32(off, r.id, true);
      off += 4;
      view.setUint32(off, 0xffffffff, true);
      off += 4;
      view.setUint32(off, r.value.length, true);
      off += 4;
      for (let i = 0; i < r.value.length; ++i) {
        view.setUint16(off, r.value.charCodeAt(i), true);
        off += 2;
      }
    }
    for (const r of nameRecords) {
      view.setUint32(off, r.id, true);
      off += 4;
      view.setUint32(off, r.key.length, true);
      off += 4;
      for (let i = 0; i < r.key.length; ++i) {
        view.setUint8(off, r.key.charCodeAt(i));
        off += 1;
      }
    }
    const table = parseStf(out);
    expect(table.entries.size).toBe(3);
    expect(table.entries.get('imperial')).toBe('Imperial');
    expect(table.entries.get('neutral')).toBe('Neutral');
    expect(table.entries.get('rebel')).toBe('Rebel');
    // Preserve the on-disk name-record order:
    expect([...table.entries.keys()]).toEqual(['imperial', 'neutral', 'rebel']);
  });

  it('parses a 3-entry table with non-ASCII (CJK + Latin extended) wide chars', () => {
    // Mix BMP code points: greeting (Japanese), Latin-1 supplement, CJK.
    // These trigger the high-byte path of the u16 LE decode that ASCII
    // can't exercise on its own.
    const bytes = buildStf({
      version: 1,
      nextUniqueId: 4,
      entries: [
        { id: 1, key: 'greeting_ja', value: 'こんにちは' }, // 5 hiragana
        { id: 2, key: 'umlaut', value: 'grüßen' }, // grüßen
        { id: 3, key: 'cjk', value: '日本語' }, // 日本語
      ],
    });
    const table = parseStf(bytes);
    expect(table.entries.get('greeting_ja')).toBe('こんにちは');
    expect(table.entries.get('umlaut')).toBe('grüßen');
    expect(table.entries.get('cjk')).toBe('日本語');
  });

  it('parses an empty table without throwing', () => {
    const bytes = buildStf({ version: 1, nextUniqueId: 0, entries: [] });
    const table = parseStf(bytes);
    expect(table.language).toBe('');
    expect(table.entries.size).toBe(0);
  });

  it('accepts version 0 (legacy timestamp slot in place of crc)', () => {
    // v0 spec: same shape as v1, but the "crc" field is a discarded
    // last-modified timestamp instead of a CRC. Our reader ignores both,
    // so v0 should parse identically.
    const bytes = buildStf({
      version: 0,
      nextUniqueId: 2,
      entries: [{ id: 1, key: 'legacy_key', value: 'legacy_value' }],
    });
    const table = parseStf(bytes);
    expect(table.entries.get('legacy_key')).toBe('legacy_value');
  });
});

describe('parseStf — error cases', () => {
  it('throws on bad magic', () => {
    const bytes = new Uint8Array([0xde, 0xad, 0xbe, 0xef, 0x01]);
    expect(() => parseStf(bytes)).toThrow(/bad magic/);
  });

  it('throws on unsupported version', () => {
    const bytes = new Uint8Array(13);
    new DataView(bytes.buffer).setUint32(0, 0xabcd, true);
    bytes[4] = 99;
    expect(() => parseStf(bytes)).toThrow(/unsupported version/);
  });

  it('throws on truncated header', () => {
    expect(() => parseStf(new Uint8Array([0xcd, 0xab]))).toThrow(/truncated header/);
  });

  it('throws on truncated table header (header ok but no nextUniqueId)', () => {
    const bytes = new Uint8Array([0xcd, 0xab, 0x00, 0x00, 0x01, 0x00]);
    expect(() => parseStf(bytes)).toThrow(/truncated table header/);
  });

  it('throws on truncated string record', () => {
    // Header is good, numEntries=1, but we're missing every byte of the
    // string record.
    const bytes = new Uint8Array(13);
    const view = new DataView(bytes.buffer);
    view.setUint32(0, 0xabcd, true);
    bytes[4] = 1;
    view.setUint32(5, 1, true);
    view.setUint32(9, 1, true);
    expect(() => parseStf(bytes)).toThrow(/(exceeds available bytes|truncated string record)/);
  });

  it('throws on truncated wide-string body', () => {
    // Build a valid header + record header that promises 10 wide chars,
    // but cut off the buffer before any of them. The catch is that our
    // up-front numEntries bound passes (the buffer is big enough for the
    // minimum 12+8 = 20 bytes per entry), so we hit the per-record check.
    // Use a chunky claimed wideLen so the over-promise is unambiguous.
    const bytes = new Uint8Array([
      0xcd,
      0xab,
      0x00,
      0x00,
      0x01, // header
      0x02,
      0x00,
      0x00,
      0x00, // nextUniqueId=2
      0x01,
      0x00,
      0x00,
      0x00, // numEntries=1
      0x01,
      0x00,
      0x00,
      0x00, // id=1
      0xff,
      0xff,
      0xff,
      0xff, // crc
      0xff,
      0xff,
      0xff,
      0x7f, // wideLen=0x7fffffff (lots, way beyond buffer)
    ]);
    expect(() => parseStf(bytes)).toThrow(/(exceeds available bytes|truncated wide string)/);
  });

  it('throws on duplicate string ids', () => {
    // Two records with the same id — corrupted file or builder bug.
    const bytes = buildStf({
      version: 1,
      nextUniqueId: 3,
      entries: [
        { id: 1, key: 'a', value: 'one' },
        { id: 1, key: 'b', value: 'two' },
      ],
    });
    expect(() => parseStf(bytes)).toThrow(/duplicate string id/);
  });

  it('throws when a name record references an unknown id', () => {
    // Build the bytes by hand: string table has id=1, name table has id=99.
    const out = new Uint8Array(5 + 8 + 12 + 4 * 2 + 8 + 3);
    const view = new DataView(out.buffer);
    let off = 0;
    view.setUint32(off, 0xabcd, true);
    off += 4;
    view.setUint8(off, 1);
    off += 1;
    view.setUint32(off, 2, true);
    off += 4;
    view.setUint32(off, 1, true);
    off += 4;
    // String record id=1, value="four"
    view.setUint32(off, 1, true);
    off += 4;
    view.setUint32(off, 0xffffffff, true);
    off += 4;
    view.setUint32(off, 4, true);
    off += 4;
    for (const ch of 'four') {
      view.setUint16(off, ch.charCodeAt(0), true);
      off += 2;
    }
    // Name record id=99, key="key"
    view.setUint32(off, 99, true);
    off += 4;
    view.setUint32(off, 3, true);
    off += 4;
    for (const ch of 'key') {
      view.setUint8(off, ch.charCodeAt(0));
      off += 1;
    }
    expect(() => parseStf(out)).toThrow(/unknown string id 99/);
  });
});

describe('parseStf — on-disk fixtures', () => {
  it("decodes string/en/hair_lookat.stf (1 entry, 'default' → 'hair')", () => {
    const bytes = readFileSync(join(FIXTURE_DIR, 'stf-hair-lookat-en.stf'));
    const table = parseStf(bytes);
    expect(table.entries.size).toBe(1);
    expect(table.entries.get('default')).toBe('hair');
  });

  it('decodes string/en/pvp_factions.stf (3 entries, ASCII keys + values)', () => {
    const bytes = readFileSync(join(FIXTURE_DIR, 'stf-pvp-factions-en.stf'));
    const table = parseStf(bytes);
    expect(table.entries.size).toBe(3);
    expect(table.entries.get('neutral')).toBe('Neutral');
    expect(table.entries.get('imperial')).toBe('Imperial');
    expect(table.entries.get('rebel')).toBe('Rebel');
  });

  it('decodes string/ja/chat_format_abbrevs.stf (wide-char Japanese value)', () => {
    const bytes = readFileSync(join(FIXTURE_DIR, 'stf-chat-format-abbrevs-ja.stf'));
    const table = parseStf(bytes);
    expect(table.entries.size).toBe(1);
    const value = table.entries.get('default');
    expect(value).toBeDefined();
    // The fixture's value is 31 UTF-16 code units of mixed katakana, kanji,
    // and ASCII. We don't pin the exact text (it depends on the SOE
    // localization team's choices), but we DO assert it has high-byte
    // characters, which proves the wide decoder runs end-to-end.
    expect(value?.length).toBeGreaterThan(0);
    const hasNonAscii = [...(value ?? '')].some((c) => c.charCodeAt(0) > 0x7f);
    expect(hasNonAscii).toBe(true);
  });
});
