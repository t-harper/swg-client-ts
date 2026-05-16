import { describe, expect, it } from 'vitest';
import {
  AutoArrayCodec,
  AutoVariableCodec,
  MapCodec,
  PairCodec,
  SetCodec,
  VectorCodec,
} from './containers.js';
import { ByteStream } from './byte-stream.js';
import { ReadIterator } from './read-iterator.js';
import { I32, U16, U32 } from './primitives.js';
import { StringCodec } from './string.js';

describe('AutoArrayCodec', () => {
  it('encodes count as uint32 LE followed by items', () => {
    const codec = AutoArrayCodec(U32);
    const s = new ByteStream();
    codec.encode(s, [10, 20, 30]);
    // [u32 LE 3][u32 LE 10][u32 LE 20][u32 LE 30]
    expect(s.length).toBe(16);
    const bytes = s.toBytes();
    expect(Array.from(bytes.subarray(0, 4))).toEqual([3, 0, 0, 0]);
    expect(Array.from(bytes.subarray(4, 8))).toEqual([10, 0, 0, 0]);
  });

  it('round-trips an empty array', () => {
    const codec = AutoArrayCodec(U16);
    const s = new ByteStream();
    codec.encode(s, []);
    expect(codec.decode(new ReadIterator(s.toBytes()))).toEqual([]);
  });

  it('round-trips an array of strings', () => {
    const codec = AutoArrayCodec(StringCodec);
    const s = new ByteStream();
    const v = ['alpha', 'beta', 'gamma'];
    codec.encode(s, v);
    expect(codec.decode(new ReadIterator(s.toBytes()))).toEqual(v);
  });
});

describe('VectorCodec', () => {
  it('encodes count as int32 LE', () => {
    const codec = VectorCodec(I32);
    const s = new ByteStream();
    codec.encode(s, [-1, 0, 1]);
    const bytes = s.toBytes();
    expect(Array.from(bytes.subarray(0, 4))).toEqual([3, 0, 0, 0]);
  });

  it('round-trips ints', () => {
    const codec = VectorCodec(I32);
    const s = new ByteStream();
    codec.encode(s, [-2_000_000, 0, 2_000_000]);
    expect(codec.decode(new ReadIterator(s.toBytes()))).toEqual([-2_000_000, 0, 2_000_000]);
  });
});

describe('SetCodec', () => {
  it('round-trips a small string set', () => {
    const codec = SetCodec(StringCodec);
    const s = new ByteStream();
    const v = new Set(['enabled', 'disabled']);
    codec.encode(s, v);
    const out = codec.decode(new ReadIterator(s.toBytes()));
    expect(out).toEqual(v);
  });
});

describe('PairCodec', () => {
  it('writes A then B with no separator', () => {
    const codec = PairCodec(StringCodec, U32);
    const s = new ByteStream();
    codec.encode(s, ['hi', 42]);
    // [u16 LE 2][hi][u32 LE 42]
    const bytes = s.toBytes();
    expect(Array.from(bytes.subarray(0, 4))).toEqual([2, 0, 0x68, 0x69]);
    expect(codec.decode(new ReadIterator(bytes))).toEqual(['hi', 42]);
  });
});

describe('AutoVariableCodec', () => {
  it('is a passthrough — no count framing', () => {
    const codec = AutoVariableCodec(U32);
    const s = new ByteStream();
    codec.encode(s, 0xdeadbeef);
    expect(s.length).toBe(4);
    expect(codec.decode(new ReadIterator(s.toBytes()))).toBe(0xdeadbeef);
  });
});

describe('MapCodec', () => {
  it('round-trips a small string→int map', () => {
    const codec = MapCodec(StringCodec, I32);
    const s = new ByteStream();
    const v = new Map<string, number>([
      ['a', 1],
      ['b', 2],
    ]);
    codec.encode(s, v);
    const out = codec.decode(new ReadIterator(s.toBytes()));
    expect(out).toEqual(v);
  });
});
