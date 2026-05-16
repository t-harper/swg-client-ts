import { describe, expect, it } from 'vitest';
import { packGroup, packMulti, unpackGroup, unpackMulti } from './multipacket.js';

describe('packMulti / unpackMulti', () => {
  it('round-trips a couple of sub-messages', () => {
    const a = new Uint8Array([0xaa, 0xbb, 0xcc]);
    const b = new Uint8Array([0x11]);
    const c = new Uint8Array([0x42, 0x42, 0x42, 0x42]);
    const packed = packMulti([a, b, c]);
    expect(packed).toEqual(
      new Uint8Array([
        0x00,
        0x03, // multi opcode
        0x03,
        0xaa,
        0xbb,
        0xcc, // sub a
        0x01,
        0x11, // sub b
        0x04,
        0x42,
        0x42,
        0x42,
        0x42, // sub c
      ]),
    );
    const unpacked = unpackMulti(packed);
    expect(unpacked.length).toBe(3);
    expect(unpacked[0]).toEqual(a);
    expect(unpacked[1]).toEqual(b);
    expect(unpacked[2]).toEqual(c);
  });

  it('handles zero-length sub-messages', () => {
    const packed = packMulti([new Uint8Array(0), new Uint8Array([0x99])]);
    expect(packed).toEqual(new Uint8Array([0x00, 0x03, 0x00, 0x01, 0x99]));
    const unpacked = unpackMulti(packed);
    expect(unpacked.length).toBe(2);
    expect(unpacked[0]?.length).toBe(0);
    expect(unpacked[1]).toEqual(new Uint8Array([0x99]));
  });

  it('throws on too-large sub-message', () => {
    const tooBig = new Uint8Array(256);
    expect(() => packMulti([tooBig])).toThrow();
  });

  it('throws on truncated unpack', () => {
    // length byte 0x05 but only 3 bytes follow
    const bogus = new Uint8Array([0x00, 0x03, 0x05, 0x01, 0x02, 0x03]);
    expect(() => unpackMulti(bogus)).toThrow();
  });

  it('throws on wrong opcode', () => {
    expect(() => unpackMulti(new Uint8Array([0x00, 0x09]))).toThrow();
  });

  it('empty Multi (no sub-messages) is valid', () => {
    const packed = packMulti([]);
    expect(packed).toEqual(new Uint8Array([0x00, 0x03]));
    expect(unpackMulti(packed)).toEqual([]);
  });
});

describe('packGroup / unpackGroup', () => {
  it('round-trips small sub-messages (1-byte length prefix)', () => {
    const a = new Uint8Array([1, 2, 3]);
    const b = new Uint8Array([4]);
    const c = new Uint8Array([5, 6, 7, 8, 9]);
    const packed = packGroup([a, b, c]);
    // [00 19][03 01 02 03][01 04][05 05 06 07 08 09]
    expect(packed).toEqual(
      new Uint8Array([
        0x00, 0x19, 0x03, 0x01, 0x02, 0x03, 0x01, 0x04, 0x05, 0x05, 0x06, 0x07, 0x08, 0x09,
      ]),
    );
    const unpacked = unpackGroup(packed);
    expect(unpacked.length).toBe(3);
    expect(unpacked[0]).toEqual(a);
    expect(unpacked[1]).toEqual(b);
    expect(unpacked[2]).toEqual(c);
  });

  it('round-trips a large sub-message (3-byte length prefix)', () => {
    const big = new Uint8Array(500);
    for (let i = 0; i < big.length; i++) big[i] = (i * 13) & 0xff;
    const packed = packGroup([big]);
    // [00 19][0xff][BE u16 = 500][500 bytes]
    expect(packed.length).toBe(2 + 3 + 500);
    expect(packed[2]).toBe(0xff);
    expect(packed[3]).toBe((500 >>> 8) & 0xff);
    expect(packed[4]).toBe(500 & 0xff);
    const unpacked = unpackGroup(packed);
    expect(unpacked.length).toBe(1);
    expect(unpacked[0]).toEqual(big);
  });

  it('round-trips a very large sub-message (7-byte length prefix)', () => {
    // 100K bytes triggers the 7-byte form (>= 0xffff)
    const huge = new Uint8Array(100000);
    for (let i = 0; i < huge.length; i++) huge[i] = (i * 7) & 0xff;
    const packed = packGroup([huge]);
    expect(packed.length).toBe(2 + 7 + 100000);
    expect(packed[2]).toBe(0xff);
    expect(packed[3]).toBe(0xff);
    expect(packed[4]).toBe(0xff);
    const unpacked = unpackGroup(packed);
    expect(unpacked.length).toBe(1);
    expect(unpacked[0]).toEqual(huge);
  });

  it('throws on wrong opcode', () => {
    expect(() => unpackGroup(new Uint8Array([0x00, 0x09]))).toThrow();
  });

  it('throws on truncated unpack', () => {
    // length=5 but only 2 bytes follow
    const bogus = new Uint8Array([0x00, 0x19, 0x05, 0x01, 0x02]);
    expect(() => unpackGroup(bogus)).toThrow();
  });
});
