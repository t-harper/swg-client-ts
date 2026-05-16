import { Buffer } from 'node:buffer';
import { describe, expect, it } from 'vitest';
import { ByteStream } from './byte-stream.js';
import { ReadException } from './interface.js';
import { ReadIterator } from './read-iterator.js';

describe('ByteStream + ReadIterator (LE primitives)', () => {
  it('round-trips u8 / i8', () => {
    const s = new ByteStream();
    s.writeU8(0);
    s.writeU8(255);
    s.writeI8(-128);
    s.writeI8(127);
    const i = new ReadIterator(s.toBytes());
    expect(i.readU8()).toBe(0);
    expect(i.readU8()).toBe(255);
    expect(i.readI8()).toBe(-128);
    expect(i.readI8()).toBe(127);
    expect(i.remaining).toBe(0);
  });

  it('round-trips u16 / i16 in LE', () => {
    const s = new ByteStream();
    s.writeU16(0xabcd);
    s.writeI16(-1);
    const bytes = s.toBytes();
    // Little-endian: low byte first
    expect(bytes[0]).toBe(0xcd);
    expect(bytes[1]).toBe(0xab);
    expect(bytes[2]).toBe(0xff);
    expect(bytes[3]).toBe(0xff);
    const i = new ReadIterator(bytes);
    expect(i.readU16()).toBe(0xabcd);
    expect(i.readI16()).toBe(-1);
  });

  it('round-trips u32 / i32 in LE', () => {
    const s = new ByteStream();
    s.writeU32(0xdeadbeef);
    s.writeI32(-2_147_483_648);
    s.writeI32(2_147_483_647);
    const bytes = s.toBytes();
    // 0xdeadbeef LE: ef be ad de
    expect(Array.from(bytes.subarray(0, 4))).toEqual([0xef, 0xbe, 0xad, 0xde]);
    const i = new ReadIterator(bytes);
    expect(i.readU32()).toBe(0xdeadbeef);
    expect(i.readI32()).toBe(-2_147_483_648);
    expect(i.readI32()).toBe(2_147_483_647);
  });

  it('round-trips u64 / i64 as bigint in LE', () => {
    const s = new ByteStream();
    const u = 0x123456789abcdef0n;
    s.writeU64(u);
    s.writeI64(-1n);
    const i = new ReadIterator(s.toBytes());
    expect(i.readU64()).toBe(u);
    expect(i.readI64()).toBe(-1n);
  });

  it('round-trips floats', () => {
    const s = new ByteStream();
    s.writeF32(3.5);
    s.writeF64(Math.PI);
    const i = new ReadIterator(s.toBytes());
    expect(i.readF32()).toBeCloseTo(3.5, 6);
    expect(i.readF64()).toBeCloseTo(Math.PI, 14);
  });

  it('round-trips bools', () => {
    const s = new ByteStream();
    s.writeBool(true);
    s.writeBool(false);
    const bytes = s.toBytes();
    expect(bytes[0]).toBe(1);
    expect(bytes[1]).toBe(0);
    const i = new ReadIterator(bytes);
    expect(i.readBool()).toBe(true);
    expect(i.readBool()).toBe(false);
  });

  it('grows past initial capacity transparently', () => {
    const s = new ByteStream(8);
    for (let n = 0; n < 1000; n++) s.writeU32(n);
    expect(s.length).toBe(4000);
    const i = new ReadIterator(s.toBytes());
    for (let n = 0; n < 1000; n++) expect(i.readU32()).toBe(n);
  });

  it('throws ReadException when reading past end', () => {
    const i = new ReadIterator(new Uint8Array([1, 2, 3]));
    i.readU16();
    expect(() => i.readU16()).toThrow(ReadException);
  });

  it('peeks without advancing', () => {
    const i = new ReadIterator(new Uint8Array([1, 2, 3]));
    expect(i.peekU8()).toBe(1);
    expect(i.peekU8(1)).toBe(2);
    expect(i.position).toBe(0);
  });

  it('subIterator() peels off N bytes and shares memory', () => {
    const i = new ReadIterator(new Uint8Array([1, 2, 3, 4, 5, 6]));
    const sub = i.subIterator(3);
    expect(sub.length).toBe(3);
    expect(sub.readU8()).toBe(1);
    expect(i.position).toBe(3);
    expect(i.readU8()).toBe(4);
  });

  it('writeBytes / readBytes preserves byte sequence', () => {
    const s = new ByteStream();
    const payload = new Uint8Array([0xde, 0xad, 0xbe, 0xef, 0x00, 0xff]);
    s.writeBytes(payload);
    const i = new ReadIterator(s.toBytes());
    const out = i.readBytes(payload.length);
    expect(Array.from(out)).toEqual(Array.from(payload));
  });

  it('viewBytes returns a zero-copy view that advances the cursor', () => {
    const i = new ReadIterator(new Uint8Array([0x11, 0x22, 0x33, 0x44]));
    const view = i.viewBytes(2);
    expect(view.byteLength).toBe(2);
    expect(view[0]).toBe(0x11);
    expect(view[1]).toBe(0x22);
    expect(i.position).toBe(2);
    expect(i.readU8()).toBe(0x33);
  });

  it('initializes from a Buffer slice with offset', () => {
    const buf = Buffer.from([0xaa, 0xbb, 0xcc, 0xdd, 0xee]);
    const i = new ReadIterator(buf, 1, 3);
    expect(i.length).toBe(3);
    expect(i.readU8()).toBe(0xbb);
    expect(i.readU16()).toBe(0xddcc);
    expect(i.remaining).toBe(0);
  });
});
