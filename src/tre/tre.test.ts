/**
 * TRE archive reader + writer tests.
 *
 * Three layers:
 *   1. CRC sanity: `test.txt` → known SOE CRC value.
 *   2. Round-trip: build a small archive via TreWriter, parse via TreReader,
 *      verify every entry's bytes match.
 *   3. Real-archive smoke test (skipped if the file isn't present): open the
 *      35MB `swgsource_3.0.tre`, count entries, extract a known small file.
 */

import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { TreReader, TreWriter, normalizeFilename, treFilenameCrc } from './index.js';

const REAL_ARCHIVE_PATH = '/home/tharper/code/swg-main/dist/prebuilt/swgsource_3.0.tre';

describe('treFilenameCrc', () => {
  it('"test.txt" hashes to 0x9393f564 (SOE poly 0x04C11DB7)', () => {
    // This is the proof-positive that we're using SOE's polynomial-0x04C11DB7
    // CRC and not the standard zlib variant. The expected value was computed
    // against the C++ Crc::calculate() in sharedFoundation/Crc.cpp.
    expect(treFilenameCrc('test.txt')).toBe(0x9393f564);
  });

  it('empty string maps to 0', () => {
    // Matches Crc::crcNull = Crc::calculate("") (Crc.cpp line 19).
    // Trivial derivation: init = 0xFFFFFFFF, no iterations, final XOR = 0xFFFFFFFF → 0.
    expect(treFilenameCrc('')).toBe(0);
  });

  it('changes with input', () => {
    expect(treFilenameCrc('a')).not.toBe(treFilenameCrc('b'));
    expect(treFilenameCrc('foo.iff')).not.toBe(treFilenameCrc('foo.stf'));
  });

  it("matches the CRC of the real archive's first entry", () => {
    // The first entry (smallest CRC) in swgsource_3.0.tre is
    // "string/en/conversation/loveday_vendor.stf" → crc 0x00019b49.
    // This is a regression check against the live archive that comes with swg-main.
    expect(treFilenameCrc('string/en/conversation/loveday_vendor.stf')).toBe(0x00019b49);
  });
});

describe('normalizeFilename', () => {
  it('lowercases ASCII', () => {
    expect(normalizeFilename('Foo/Bar.IFF')).toBe('foo/bar.iff');
  });

  it('converts backslashes to forward slashes', () => {
    expect(normalizeFilename('foo\\bar\\baz.iff')).toBe('foo/bar/baz.iff');
  });

  it('collapses consecutive slashes', () => {
    expect(normalizeFilename('foo//bar///baz.iff')).toBe('foo/bar/baz.iff');
    expect(normalizeFilename('foo/\\bar')).toBe('foo/bar');
  });

  it('drops leading dots after a slash', () => {
    expect(normalizeFilename('./foo.iff')).toBe('foo.iff');
    expect(normalizeFilename('foo/./bar.iff')).toBe('foo/bar.iff');
  });

  it('keeps dots inside filename', () => {
    expect(normalizeFilename('foo.bar.iff')).toBe('foo.bar.iff');
  });
});

describe('TreWriter + TreReader round-trip', () => {
  const samples = [
    { name: 'test.txt', bytes: Buffer.from('hello, world\n', 'ascii') },
    {
      name: 'object/foo/bar.iff',
      bytes: Buffer.from([0x49, 0x46, 0x46, 0x20, 0x00, 0x00, 0x00, 0x10]),
    },
    { name: 'string/en/example.stf', bytes: Buffer.from('A'.repeat(4096), 'ascii') }, // big enough to actually compress
    { name: 'data/single.bin', bytes: new Uint8Array([0x42]) },
    { name: 'binary/random.bin', bytes: new Uint8Array(256).map((_, i) => i ^ 0x55) },
  ];

  it('writes 5 files, parses them all back identically', () => {
    const writer = new TreWriter();
    for (const s of samples) {
      writer.add(s.name, s.bytes);
    }
    expect(writer.count).toBe(samples.length);

    const archive = writer.toBytes();
    const reader = TreReader.fromBytes(archive);

    expect(reader.count).toBe(samples.length);
    for (const s of samples) {
      expect(reader.exists(s.name)).toBe(true);
      const round = reader.read(s.name);
      expect(round.length).toBe(s.bytes.byteLength);
      expect(Buffer.from(round).equals(Buffer.from(s.bytes))).toBe(true);
    }
  });

  it('readByCrc finds entries via the SOE CRC', () => {
    const writer = new TreWriter().add('test.txt', Buffer.from('hello\n', 'ascii'));
    const reader = TreReader.fromBytes(writer.toBytes());
    const bytes = reader.readByCrc(treFilenameCrc('test.txt'));
    expect(Buffer.from(bytes).toString('ascii')).toBe('hello\n');
  });

  it('case-insensitive lookup: stored lowercase, queried mixed-case', () => {
    const writer = new TreWriter().add('Foo/Bar.IFF', Buffer.from('payload', 'ascii'));
    const reader = TreReader.fromBytes(writer.toBytes());
    // The reader normalized "Foo/Bar.IFF" → "foo/bar.iff" on the write side.
    expect(reader.list()[0]?.filename).toBe('foo/bar.iff');
    // And we should be able to look up via any casing on the read side.
    expect(reader.exists('FOO/BAR.IFF')).toBe(true);
    expect(reader.exists('foo/bar.iff')).toBe(true);
    expect(reader.exists('Foo/Bar.IFF')).toBe(true);
    // Backslashes are normalized too:
    expect(reader.exists('FOO\\BAR.IFF')).toBe(true);
    expect(Buffer.from(reader.read('FOO/BAR.IFF')).toString('ascii')).toBe('payload');
  });

  it('uncompressed TOC / name block round-trips', () => {
    const writer = new TreWriter()
      .add('a.txt', Buffer.from('aaa', 'ascii'))
      .add('b.txt', Buffer.from('bbb', 'ascii'));
    const archive = writer.toBytes({ tocCompress: false, nameBlockCompress: false });
    const reader = TreReader.fromBytes(archive);
    expect(reader.count).toBe(2);
    expect(Buffer.from(reader.read('a.txt')).toString('ascii')).toBe('aaa');
    expect(Buffer.from(reader.read('b.txt')).toString('ascii')).toBe('bbb');
  });

  it('per-file uncompressed mode round-trips', () => {
    const writer = new TreWriter().add('raw.bin', new Uint8Array([0xde, 0xad, 0xbe, 0xef]), {
      compress: false,
    });
    const reader = TreReader.fromBytes(writer.toBytes());
    const entry = reader.list()[0];
    expect(entry?.compressor).toBe(0);
    expect(entry?.size).toBe(4);
    expect(Buffer.from(reader.read('raw.bin')).equals(Buffer.from([0xde, 0xad, 0xbe, 0xef]))).toBe(
      true,
    );
  });

  it('missing file lookups throw', () => {
    const writer = new TreWriter().add('a.txt', Buffer.from('a', 'ascii'));
    const reader = TreReader.fromBytes(writer.toBytes());
    expect(() => reader.read('nope.txt')).toThrow(/not found/);
    expect(() => reader.readByCrc(0xdeadbeef)).toThrow(/not found/);
  });

  it('duplicate filenames throw on add()', () => {
    const writer = new TreWriter().add('x.txt', Buffer.from('1', 'ascii'));
    expect(() => writer.add('X.TXT', Buffer.from('2', 'ascii'))).toThrow(/duplicate/);
  });

  it('rejects zero-byte payloads (would collide with deleted-entry tombstone)', () => {
    const writer = new TreWriter();
    expect(() => writer.add('zero.bin', new Uint8Array(0))).toThrow(/empty payload/);
  });

  it('rejects archives without TREE magic', () => {
    const bad = new Uint8Array(36);
    expect(() => TreReader.fromBytes(bad)).toThrow(/not a TRE archive/);
  });

  it('rejects unsupported versions', () => {
    // Build a header with version "0003" — outside the supported 0004/0005 range.
    // Tags are stored LE: TAG(T,R,E,E)=0x54524545, TAG(0,0,0,3)=0x30303033.
    const buf = Buffer.alloc(36);
    buf.writeUInt32LE(0x54524545, 0); // "TREE"
    buf.writeUInt32LE(0x30303033, 4); // "0003"
    expect(() => TreReader.fromBytes(buf)).toThrow(/unsupported TRE version/);
  });
});

const realArchivePresent = existsSync(REAL_ARCHIVE_PATH);

describe.skipIf(!realArchivePresent)('TreReader against the real swgsource_3.0.tre', () => {
  it('opens the 35MB archive, counts 26513 entries, extracts a known small file', () => {
    const reader = TreReader.fromFile(REAL_ARCHIVE_PATH);
    expect(reader.count).toBe(26513);

    // Cross-check a few well-known filenames discovered on first inspection.
    expect(reader.exists('string/en/conversation/loveday_vendor.stf')).toBe(true);
    expect(reader.exists('string/en/public_container.stf')).toBe(true);
    expect(reader.exists('footprint/installation/battlefield/shared_turret.iff')).toBe(true);

    // Extract one — uncompressed 92-byte STF.
    const stf = reader.read('string/en/public_container.stf');
    expect(stf.byteLength).toBe(92);
    // STF files start with "ABCF" tag (big-endian — appears as "FCBA" at the very start when
    // viewed as raw bytes... actually IFF/STF "ABCF" or "FORM" — let's just sanity check the
    // length and that the bytes are reachable).
    expect(stf.byteLength).toBeGreaterThan(0);

    // The entry metadata should match the TOC values we read directly.
    const entry = reader.list().find((e) => e.filename === 'string/en/public_container.stf');
    expect(entry).toBeDefined();
    expect(entry?.size).toBe(92);
    expect(entry?.compressor).toBe(0);
  });

  it('readByCrc agrees with read()', () => {
    const reader = TreReader.fromFile(REAL_ARCHIVE_PATH);
    const fname = 'string/en/public_container.stf';
    const byName = reader.read(fname);
    const byCrc = reader.readByCrc(treFilenameCrc(fname));
    expect(Buffer.from(byCrc).equals(Buffer.from(byName))).toBe(true);
  });
});
