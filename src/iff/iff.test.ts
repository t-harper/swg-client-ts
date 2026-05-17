/**
 * Tests for the IFF read/write port. Combines:
 *   - tag <-> string helpers (`tagFromString` / `tagToString`)
 *   - hand-built golden-byte round-trips (writer -> bytes -> reader)
 *   - real on-disk SOE files (`local_machine_options.iff` /
 *     `stella_admin.iff` / `naboo.trn`) to confirm the parser sees what
 *     `xxd` shows.
 */
import { readFileSync, statSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { Iff, IffWriter, TAG_FORM, tag, tagFromString, tagToString } from './index.js';

// ---------------------------------------------------------------------------
// External fixtures (read-only; not committed to this repo)
// ---------------------------------------------------------------------------

const SWG_MAIN = '/home/tharper/code/swg-main';
const FIXTURE_OPTIONS = `${SWG_MAIN}/exe/linux/local_machine_options.iff`;
const FIXTURE_STELLA = `${SWG_MAIN}/data/sku.0/sys.server/compiled/game/datatables/admin/stella_admin.iff`;
const FIXTURE_NABOO = `${SWG_MAIN}/serverdata/terrain/naboo.trn`;

function fixtureExists(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------

describe('tag helpers', () => {
  it('packs an ASCII 4-char string into the expected u32', () => {
    expect(tagFromString('FORM')).toBe(0x464f524d);
    expect(tagFromString('0003')).toBe(0x30303033);
    expect(tagFromString('PTAT')).toBe(0x50544154);
    expect(TAG_FORM).toBe(0x464f524d);
  });

  it('right-pads short tags with ASCII space (matches C++ TAG_DIGIT_SPACE)', () => {
    // C++ TAG3('F','L','T') -> 'FLT ' which is what xxd shows in local_machine_options.iff
    expect(tagFromString('FLT')).toBe(0x464c5420);
    expect(tagFromString('F')).toBe(0x46202020);
    expect(tagFromString('')).toBe(0x20202020);
  });

  it('round-trips via tagToString', () => {
    for (const s of ['FORM', '0003', 'PTAT', 'DATA', 'NULL', 'COLS']) {
      expect(tagToString(tagFromString(s))).toBe(s);
    }
  });

  it('renders non-printable bytes as ? in tagToString', () => {
    // 0x01020304 — all non-printable
    expect(tagToString(0x01020304)).toBe('????');
  });

  it('tag() helper rejects strings longer than 4', () => {
    expect(() => tag('FORMS')).toThrow(/more than 4 characters/);
    expect(tag('FORM')).toBe(TAG_FORM);
  });

  it('rejects non-ASCII characters', () => {
    expect(() => tagFromString('ĀAB ')).toThrow(/not 7-bit ASCII/);
  });
});

// ---------------------------------------------------------------------------

describe('IffWriter -> Iff round-trip', () => {
  it('writes a trivial single-chunk FORM and reads back the same structure', () => {
    const bytes = new IffWriter()
      .insertForm('TEST')
      .insertChunk('DATA')
      .writeU32(0xdeadbeef)
      .writeF32(1.5)
      .exitChunk()
      .exitForm()
      .toBytes();

    // Layout we expect on disk:
    //   00..03 'FORM'                          BE 0x464f524d
    //   04..07 outer body length (BE)          = 4 (inner type tag) + 4+4 (chunk header) + 8 (chunk body) = 20 -> 0x14
    //   08..0b 'TEST'                          BE
    //   0c..0f 'DATA'                          BE 0x44415441
    //   10..13 chunk length (BE)               = 8 -> 0x00000008
    //   14..17 0xdeadbeef LE                   ef be ad de
    //   18..1b 1.5 f32 LE                      00 00 c0 3f
    expect(bytes.byteLength).toBe(0x1c);
    const head = Array.from(bytes.subarray(0, 4));
    expect(head).toEqual([0x46, 0x4f, 0x52, 0x4d]); // 'FORM'
    expect(bytes[7]).toBe(0x14); // outer length low byte (BE)
    expect(bytes[6]).toBe(0); // outer length 2nd byte (BE)
    // inner type tag
    expect(Array.from(bytes.subarray(0x08, 0x0c))).toEqual([0x54, 0x45, 0x53, 0x54]);
    // chunk tag
    expect(Array.from(bytes.subarray(0x0c, 0x10))).toEqual([0x44, 0x41, 0x54, 0x41]);
    // chunk length BE
    expect(Array.from(bytes.subarray(0x10, 0x14))).toEqual([0, 0, 0, 8]);
    // deadbeef LE
    expect(Array.from(bytes.subarray(0x14, 0x18))).toEqual([0xef, 0xbe, 0xad, 0xde]);

    const iff = Iff.fromBytes(bytes);
    expect(iff.isCurrentForm()).toBe(true);
    expect(iff.getCurrentName()).toBe('TEST');
    iff.enterForm('TEST');
    expect(iff.atEndOfForm()).toBe(false);
    expect(iff.getNumberOfBlocksLeft()).toBe(1);
    expect(iff.isCurrentChunk()).toBe(true);
    expect(iff.getCurrentName()).toBe('DATA');
    iff.enterChunk('DATA');
    expect(iff.getChunkLengthTotal()).toBe(8);
    expect(iff.getChunkLengthLeft()).toBe(8);
    expect(iff.readU32()).toBe(0xdeadbeef);
    expect(iff.readF32()).toBe(1.5);
    expect(iff.getChunkLengthLeft()).toBe(0);
    iff.exitChunk('DATA');
    expect(iff.atEndOfForm()).toBe(true);
    iff.exitForm('TEST');
  });

  it('round-trips nested forms with multiple chunks', () => {
    const w = new IffWriter()
      .insertForm('ROOT')
      .insertChunk('NAME')
      .writeString('hello-iff')
      .exitChunk()
      .insertForm('SUB1')
      .insertChunk('INT4')
      .writeI32(-42)
      .exitChunk()
      .insertChunk('FLT4')
      .writeF32(3.25)
      .writeF32(-1.5)
      .exitChunk()
      .exitForm() // SUB1
      .insertChunk('BOOL')
      .writeBool(true)
      .writeBool(false)
      .writeBool(true)
      .exitChunk()
      .exitForm(); // ROOT
    const bytes = w.toBytes();

    const iff = Iff.fromBytes(bytes);
    iff.enterForm('ROOT');
    expect(iff.getNumberOfBlocksLeft()).toBe(3);

    // chunk 1: NAME
    expect(iff.isCurrentChunk()).toBe(true);
    expect(iff.getCurrentName()).toBe('NAME');
    iff.enterChunk('NAME');
    expect(iff.readString()).toBe('hello-iff');
    expect(iff.getChunkLengthLeft()).toBe(0);
    iff.exitChunk('NAME');

    // block 2: SUB1 form
    expect(iff.isCurrentForm()).toBe(true);
    expect(iff.getCurrentName()).toBe('SUB1');
    iff.enterForm('SUB1');
    expect(iff.getNumberOfBlocksLeft()).toBe(2);
    iff.enterChunk('INT4');
    expect(iff.readI32()).toBe(-42);
    iff.exitChunk('INT4');
    iff.enterChunk('FLT4');
    expect(iff.readF32()).toBe(3.25);
    expect(iff.readF32()).toBe(-1.5);
    iff.exitChunk('FLT4');
    iff.exitForm('SUB1');

    // chunk 3: BOOL
    iff.enterChunk('BOOL');
    expect(iff.readBool()).toBe(true);
    expect(iff.readBool()).toBe(false);
    expect(iff.readBool()).toBe(true);
    iff.exitChunk('BOOL');

    expect(iff.atEndOfForm()).toBe(true);
    iff.exitForm('ROOT');
  });

  it('round-trips all numeric primitive types', () => {
    const bytes = new IffWriter()
      .insertForm('NUMS')
      .insertChunk('ALL ')
      .writeU8(0xff)
      .writeI8(-1)
      .writeU16(0xabcd)
      .writeI16(-2)
      .writeU32(0xfeedface)
      .writeI32(-3)
      .writeU64(0xdeadbeefcafebaben)
      .writeI64(-4n)
      .writeF32(2.5)
      .writeF64(Math.PI)
      .writeBool(true)
      .writeBool(false)
      .exitChunk()
      .exitForm()
      .toBytes();

    const iff = Iff.fromBytes(bytes);
    iff.enterForm('NUMS');
    iff.enterChunk('ALL ');
    expect(iff.readU8()).toBe(0xff);
    expect(iff.readI8()).toBe(-1);
    expect(iff.readU16()).toBe(0xabcd);
    expect(iff.readI16()).toBe(-2);
    expect(iff.readU32()).toBe(0xfeedface);
    expect(iff.readI32()).toBe(-3);
    expect(iff.readU64()).toBe(0xdeadbeefcafebaben);
    expect(iff.readI64()).toBe(-4n);
    expect(iff.readF32()).toBe(2.5);
    expect(iff.readF64()).toBe(Math.PI);
    expect(iff.readBool()).toBe(true);
    expect(iff.readBool()).toBe(false);
    iff.exitChunk();
    iff.exitForm();
  });

  it('round-trips wide (UTF-16) strings', () => {
    const text = 'Hello, ä œ 中文'; // mix of ASCII, Latin-1, CJK
    const bytes = new IffWriter()
      .insertForm('UTXT')
      .insertChunk('STR ')
      .writeWideString(text)
      .exitChunk()
      .exitForm()
      .toBytes();

    const iff = Iff.fromBytes(bytes);
    iff.enterForm('UTXT');
    iff.enterChunk('STR ');
    expect(iff.readWideString()).toBe(text);
    iff.exitChunk();
    iff.exitForm();
  });

  it('round-trips raw byte payloads', () => {
    const payload = new Uint8Array([1, 2, 3, 4, 5, 0, 0xff, 0xfe]);
    const bytes = new IffWriter()
      .insertForm('RAW ')
      .insertChunk('BLOB')
      .writeBytes(payload)
      .exitChunk()
      .exitForm()
      .toBytes();
    const iff = Iff.fromBytes(bytes);
    iff.enterForm('RAW ');
    iff.enterChunk('BLOB');
    expect(iff.getChunkLengthTotal()).toBe(payload.byteLength);
    expect(Array.from(iff.readBytes(payload.byteLength))).toEqual(Array.from(payload));
    iff.exitChunk();
    iff.exitForm();
  });

  it('writer rejects double-exit and toBytes() with open blocks', () => {
    const w = new IffWriter().insertForm('OPEN');
    expect(() => w.toBytes()).toThrow(/unclosed/);

    const w2 = new IffWriter().insertChunk('CHNK');
    expect(() => w2.exitForm()).toThrow(/not a form/);

    const w3 = new IffWriter().insertForm('FORM');
    expect(() => w3.exitChunk()).toThrow(/not a chunk/);
  });

  it('writer rejects writing primitives outside a chunk', () => {
    const w = new IffWriter().insertForm('FORM');
    expect(() => w.writeU32(0)).toThrow(/inside an open chunk/);
  });

  it('reader rejects mismatched tag on enter*()', () => {
    const bytes = new IffWriter()
      .insertForm('AAAA')
      .insertChunk('BBBB')
      .writeU8(0)
      .exitChunk()
      .exitForm()
      .toBytes();

    const iff = Iff.fromBytes(bytes);
    expect(() => iff.enterForm('XXXX')).toThrow(/found form 'AAAA'/);

    const iff2 = Iff.fromBytes(bytes);
    iff2.enterForm('AAAA');
    expect(() => iff2.enterChunk('CCCC')).toThrow(/found chunk 'BBBB'/);
  });

  it('reader rejects reading past end of chunk', () => {
    const bytes = new IffWriter()
      .insertForm('TINY')
      .insertChunk('CHNK')
      .writeU16(7)
      .exitChunk()
      .exitForm()
      .toBytes();
    const iff = Iff.fromBytes(bytes);
    iff.enterForm('TINY');
    iff.enterChunk('CHNK');
    expect(iff.readU16()).toBe(7);
    expect(() => iff.readU8()).toThrow(/overflow/);
  });

  it('error messages include a path breadcrumb', () => {
    const bytes = new IffWriter()
      .insertForm('OUTR')
      .insertForm('INNR')
      .insertChunk('LEAF')
      .writeU8(0)
      .exitChunk()
      .exitForm()
      .exitForm()
      .toBytes();
    const iff = Iff.fromBytes(bytes);
    iff.enterForm('OUTR');
    iff.enterForm('INNR');
    iff.enterChunk('LEAF');
    iff.readU8();
    try {
      iff.readU8(); // overflow
      throw new Error('expected throw');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      expect(msg).toMatch(/OUTR\/INNR\/LEAF/);
    }
  });
});

// ---------------------------------------------------------------------------

describe('forEachChunk / forEachBlock tree walk', () => {
  it('iterates every child of a form, skipping past untouched blocks', () => {
    const bytes = new IffWriter()
      .insertForm('LIST')
      .insertChunk('A   ')
      .writeU8(1)
      .exitChunk()
      .insertChunk('B   ')
      .writeU8(2)
      .exitChunk()
      .insertForm('SUB ')
      .insertChunk('C   ')
      .writeU8(3)
      .exitChunk()
      .exitForm()
      .insertChunk('D   ')
      .writeU8(4)
      .exitChunk()
      .exitForm()
      .toBytes();

    const iff = Iff.fromBytes(bytes);
    iff.enterForm('LIST');
    const seen: Array<[string, string]> = [];
    iff.forEachBlock((t, k) => seen.push([k, t]));
    expect(seen).toEqual([
      ['chunk', 'A   '],
      ['chunk', 'B   '],
      ['form', 'SUB '],
      ['chunk', 'D   '],
    ]);
  });

  it('forEachChunk handler can fully read the chunk by entering it', () => {
    const bytes = new IffWriter()
      .insertForm('SUMS')
      .insertChunk('VAL ')
      .writeI32(10)
      .exitChunk()
      .insertChunk('VAL ')
      .writeI32(20)
      .exitChunk()
      .insertChunk('VAL ')
      .writeI32(12)
      .exitChunk()
      .exitForm()
      .toBytes();

    const iff = Iff.fromBytes(bytes);
    iff.enterForm('SUMS');
    let sum = 0;
    iff.forEachChunk((t) => {
      expect(t).toBe('VAL ');
      iff.enterChunk('VAL ');
      sum += iff.readI32();
      iff.exitChunk();
    });
    expect(sum).toBe(42);
  });
});

// ---------------------------------------------------------------------------
// Live-disk fixtures
// ---------------------------------------------------------------------------

describe.runIf(fixtureExists(FIXTURE_OPTIONS))('local_machine_options.iff', () => {
  it('parses the top-level FORM and finds the expected chunks', () => {
    const iff = Iff.fromFile(FIXTURE_OPTIONS);
    expect(iff.isCurrentForm()).toBe(true);
    expect(iff.getCurrentName()).toBe('OPTN');
    iff.enterForm('OPTN');
    expect(iff.isCurrentForm()).toBe(true);
    expect(iff.getCurrentName()).toBe('0003');
    iff.enterForm('0003');
    // Expect MANY children — at least the first 'FLT ' chunk we hex-dumped.
    expect(iff.getNumberOfBlocksLeft()).toBeGreaterThan(10);

    // The first child should be a FLT chunk holding (per xxd):
    //   length 0x34 = 52 bytes
    //   payload: [u32=0][cstring "SharedUtility/WorldSnapshot"][cstring "detailLevelBias"][u32]
    expect(iff.isCurrentChunk()).toBe(true);
    expect(iff.getCurrentName()).toBe('FLT ');
    expect(iff.getCurrentLength()).toBe(0x34);
    iff.enterChunk('FLT ');
    expect(iff.getChunkLengthTotal()).toBe(0x34);
    // First u32 is 0 ("default value present" sentinel) in this file.
    expect(iff.readU32()).toBe(0);
    expect(iff.readString()).toBe('SharedUtility/WorldSnapshot');
    expect(iff.readString()).toBe('detailLevelBias');
    iff.readU32(); // trailing payload
    expect(iff.getChunkLengthLeft()).toBe(0);
    iff.exitChunk('FLT ');

    // Walk the rest counting kinds.
    const kindCounts = { form: 0, chunk: 0 };
    iff.forEachBlock((_, k) => {
      kindCounts[k] += 1;
    });
    expect(kindCounts.chunk).toBeGreaterThan(10);
    expect(kindCounts.form).toBe(0); // local_machine_options is all flat under 0003
  });

  it('exposes the raw byte size matching the on-disk file', () => {
    const iff = Iff.fromFile(FIXTURE_OPTIONS);
    const onDisk = readFileSync(FIXTURE_OPTIONS);
    expect(iff.getRawDataSize()).toBe(onDisk.byteLength);
  });
});

describe.runIf(fixtureExists(FIXTURE_STELLA))('stella_admin.iff (datatable)', () => {
  it('descends into the DATATABLE / COLS / TYPE / ROWS structure', () => {
    const iff = Iff.fromFile(FIXTURE_STELLA);
    // SWG datatables wrap content in DTII ("data table IFF") forms.
    expect(iff.getCurrentName()).toBe('DTII');
    iff.enterForm('DTII');
    expect(iff.getCurrentName()).toBe('0001'); // datatable schema version
    iff.enterForm('0001');

    // The first child is the COLS chunk holding column names.
    expect(iff.isCurrentChunk()).toBe(true);
    expect(iff.getCurrentName()).toBe('COLS');
    expect(iff.getCurrentLength()).toBe(0x4d); // confirms what xxd shows
    iff.enterChunk('COLS');
    // First u32 LE = number of columns. xxd shows `06 00 00 00`.
    expect(iff.readU32()).toBe(6);
    // Then 6 NUL-terminated column names.
    const cols: string[] = [];
    for (let i = 0; i < 6; ++i) cols.push(iff.readString());
    expect(cols).toEqual([
      'AdminAccounts',
      'AdminLevel',
      'AdminSkill',
      'AdminIpBlocks',
      'AdminSuid',
      'OldAdminSuid',
    ]);
    expect(iff.getChunkLengthLeft()).toBe(0);
    iff.exitChunk('COLS');

    // Walk the rest — we expect at least TYPE and ROWS chunks.
    const remainingTags: string[] = [];
    iff.forEachBlock((t) => remainingTags.push(t));
    expect(remainingTags).toContain('TYPE');
    expect(remainingTags).toContain('ROWS');
  });
});

describe.runIf(fixtureExists(FIXTURE_NABOO))('naboo.trn (large file)', () => {
  it('top-level FORM is PTAT and the size field matches the file size', () => {
    // Read only the first 16 bytes — that's enough to confirm the framing.
    const buf = readFileSync(FIXTURE_NABOO);
    // Hand-parse the very first header to cross-check against our parser.
    expect(buf[0]).toBe(0x46); // 'F'
    expect(buf[1]).toBe(0x4f); // 'O'
    expect(buf[2]).toBe(0x52); // 'R'
    expect(buf[3]).toBe(0x4d); // 'M'
    // BE length at [4..8) should equal fileSize - 8 (everything except the
    // outer [FORM][length] header).
    const sizeOnDisk = buf.byteLength;
    // Use Buffer.readUInt32BE (always-defined) to avoid noUncheckedIndexedAccess noise.
    const declaredOuterBody = buf.readUInt32BE(4);
    expect(declaredOuterBody).toBe(sizeOnDisk - 8);

    // Now use our parser.
    const iff = Iff.fromBytes(buf);
    expect(iff.getCurrentName()).toBe('PTAT');
    iff.enterForm('PTAT');
    // Inner version form
    expect(iff.isCurrentForm()).toBe(true);
    expect(iff.getCurrentName()).toBe('0015');
    iff.enterForm('0015');
    expect(iff.isCurrentChunk()).toBe(true);
    expect(iff.getCurrentName()).toBe('DATA');
    iff.enterChunk('DATA');
    // First field is a NUL-terminated string with the asset path
    const path = iff.readString();
    expect(path).toMatch(/sku\.0|\.iff/);
    // We don't fully decode the rest — just confirm we can stop here cleanly.
    iff.exitChunk('DATA');
  });
});
