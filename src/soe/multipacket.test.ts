import { describe, expect, it } from 'vitest';
import { packMulti, unpackMulti } from './multipacket.js';

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
