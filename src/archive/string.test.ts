import { describe, expect, it } from 'vitest';
import { ByteStream } from './byte-stream.js';
import { ReadIterator } from './read-iterator.js';
import { readStdString, writeStdString, StringCodec } from './string.js';

describe('std::string codec', () => {
  it('round-trips empty string', () => {
    const s = new ByteStream();
    writeStdString(s, '');
    const bytes = s.toBytes();
    // [u16 LE 0]
    expect(Array.from(bytes)).toEqual([0, 0]);
    expect(readStdString(new ReadIterator(bytes))).toBe('');
  });

  it('writes uint16 LE length prefix then ASCII bytes', () => {
    const s = new ByteStream();
    writeStdString(s, 'hi');
    const bytes = s.toBytes();
    // [u16 LE 2][0x68 0x69]
    expect(Array.from(bytes)).toEqual([0x02, 0x00, 0x68, 0x69]);
  });

  it('round-trips a typical username', () => {
    const s = new ByteStream();
    writeStdString(s, 'ts-test-1234');
    const i = new ReadIterator(s.toBytes());
    expect(readStdString(i)).toBe('ts-test-1234');
    expect(i.remaining).toBe(0);
  });

  it('round-trips the NetworkVersionId server string', () => {
    const s = new ByteStream();
    writeStdString(s, '20100225-17:43');
    const i = new ReadIterator(s.toBytes());
    expect(readStdString(i)).toBe('20100225-17:43');
  });

  it('encodes large strings (>= 65535 bytes) with the escape prefix', () => {
    const big = 'a'.repeat(65535);
    const s = new ByteStream();
    writeStdString(s, big);
    const bytes = s.toBytes();
    // [u16 LE 0xFFFF][u32 LE 65535][65535 bytes of 'a']
    expect(bytes[0]).toBe(0xff);
    expect(bytes[1]).toBe(0xff);
    expect(bytes[2]).toBe(0xff);
    expect(bytes[3]).toBe(0xff);
    expect(bytes[4]).toBe(0x00);
    expect(bytes[5]).toBe(0x00);
    // Re-read
    const got = readStdString(new ReadIterator(bytes));
    expect(got).toBe(big);
  });

  it('handles boundary at 65534 (inline) and 65535 (escape)', () => {
    for (const len of [65534, 65535, 65536]) {
      const v = 'b'.repeat(len);
      const s = new ByteStream();
      writeStdString(s, v);
      expect(readStdString(new ReadIterator(s.toBytes()))).toBe(v);
    }
  });

  it('StringCodec matches free-function behavior', () => {
    const s = new ByteStream();
    StringCodec.encode(s, 'hello');
    expect(StringCodec.decode(new ReadIterator(s.toBytes()))).toBe('hello');
  });
});
