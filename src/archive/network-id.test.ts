import { describe, expect, it } from 'vitest';
import { ByteStream } from './byte-stream.js';
import { NetworkIdCodec } from './network-id.js';
import { ReadIterator } from './read-iterator.js';

describe('NetworkId codec (int64 LE)', () => {
  it('round-trips zero', () => {
    const s = new ByteStream();
    NetworkIdCodec.encode(s, 0n);
    expect(s.length).toBe(8);
    expect(NetworkIdCodec.decode(new ReadIterator(s.toBytes()))).toBe(0n);
  });

  it('round-trips a typical character id', () => {
    const s = new ByteStream();
    const id = 0x4660_0000_0000_0001n; // arbitrary 8-byte id
    NetworkIdCodec.encode(s, id);
    const out = NetworkIdCodec.decode(new ReadIterator(s.toBytes()));
    expect(out).toBe(id);
  });

  it('writes little-endian byte order', () => {
    const s = new ByteStream();
    NetworkIdCodec.encode(s, 0x0102030405060708n);
    expect(Array.from(s.toBytes())).toEqual([0x08, 0x07, 0x06, 0x05, 0x04, 0x03, 0x02, 0x01]);
  });

  it('round-trips negative ids', () => {
    const s = new ByteStream();
    NetworkIdCodec.encode(s, -1n);
    expect(NetworkIdCodec.decode(new ReadIterator(s.toBytes()))).toBe(-1n);
  });
});
