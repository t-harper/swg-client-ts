import { describe, expect, it } from 'vitest';
import { ByteStream } from './byte-stream.js';
import { ReadIterator } from './read-iterator.js';
import { readUnicodeString, writeUnicodeString } from './unicode-string.js';

describe('Unicode::String codec (UTF-16 LE)', () => {
  it('round-trips empty', () => {
    const s = new ByteStream();
    writeUnicodeString(s, '');
    const bytes = s.toBytes();
    // [u32 LE 0]
    expect(Array.from(bytes)).toEqual([0, 0, 0, 0]);
    expect(readUnicodeString(new ReadIterator(bytes))).toBe('');
  });

  it('writes a uint32 char-count then UTF-16 LE chars', () => {
    const s = new ByteStream();
    writeUnicodeString(s, 'Hi');
    const bytes = s.toBytes();
    // [u32 LE 2][H=0x48 0x00][i=0x69 0x00]
    expect(Array.from(bytes)).toEqual([0x02, 0x00, 0x00, 0x00, 0x48, 0x00, 0x69, 0x00]);
  });

  it('round-trips a player display name', () => {
    const s = new ByteStream();
    const name = 'TsTest';
    writeUnicodeString(s, name);
    const i = new ReadIterator(s.toBytes());
    expect(readUnicodeString(i)).toBe(name);
    expect(i.remaining).toBe(0);
  });

  it('handles BMP characters (Latin-1 supplement / extended)', () => {
    const s = new ByteStream();
    const name = 'Bjørn';
    writeUnicodeString(s, name);
    expect(readUnicodeString(new ReadIterator(s.toBytes()))).toBe(name);
  });

  it('handles longer strings', () => {
    const s = new ByteStream();
    const v = 'A long character name goes here.';
    writeUnicodeString(s, v);
    expect(readUnicodeString(new ReadIterator(s.toBytes()))).toBe(v);
  });
});
