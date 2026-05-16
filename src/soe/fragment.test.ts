import { describe, expect, it } from 'vitest';
import { FragmentBuffer, buildFragmentPackets } from './fragment.js';
import { parseReliablePacket } from './reliable.js';

describe('FragmentBuffer', () => {
  it('reassembles a 2-chunk fragment', () => {
    const buf = new FragmentBuffer();
    // First chunk: total length = 10, includes 6 bytes of data
    const total = 10;
    const first = new Uint8Array(4 + 6);
    first[0] = (total >>> 24) & 0xff;
    first[1] = (total >>> 16) & 0xff;
    first[2] = (total >>> 8) & 0xff;
    first[3] = total & 0xff;
    first.set([0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0xff], 4);

    const r1 = buf.addChunk(first);
    expect(r1).toBeNull();
    expect(buf.inProgress).toBe(true);

    const second = new Uint8Array([0x11, 0x22, 0x33, 0x44]);
    const r2 = buf.addChunk(second);
    expect(r2).not.toBeNull();
    expect(r2).toEqual(
      new Uint8Array([0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0xff, 0x11, 0x22, 0x33, 0x44]),
    );
    expect(buf.inProgress).toBe(false);
  });

  it('reassembles a single-chunk fragment (entire payload in first chunk)', () => {
    const buf = new FragmentBuffer();
    const total = 4;
    const first = new Uint8Array(4 + 4);
    first[3] = total;
    first.set([0xde, 0xad, 0xbe, 0xef], 4);
    const r = buf.addChunk(first);
    expect(r).toEqual(new Uint8Array([0xde, 0xad, 0xbe, 0xef]));
    expect(buf.inProgress).toBe(false);
  });

  it('throws on overflow', () => {
    const buf = new FragmentBuffer();
    const first = new Uint8Array(4 + 2);
    first[3] = 4; // total = 4 bytes
    first.set([0xaa, 0xbb], 4);
    expect(buf.addChunk(first)).toBeNull();
    // Now add 5 more bytes — overflow
    expect(() => buf.addChunk(new Uint8Array([1, 2, 3, 4, 5]))).toThrow();
  });

  it('throws on absurd total length', () => {
    const buf = new FragmentBuffer();
    const first = new Uint8Array(4 + 1);
    first[0] = 0xff;
    first[1] = 0xff;
    first[2] = 0xff;
    first[3] = 0xff;
    expect(() => buf.addChunk(first)).toThrow();
  });

  it('reset() drops in-progress state', () => {
    const buf = new FragmentBuffer();
    const first = new Uint8Array(4 + 2);
    first[3] = 10;
    first.set([0xaa, 0xbb], 4);
    buf.addChunk(first);
    expect(buf.inProgress).toBe(true);
    buf.reset();
    expect(buf.inProgress).toBe(false);
  });
});

describe('buildFragmentPackets', () => {
  it('round-trips through FragmentBuffer', () => {
    // 100-byte payload, chunkSize=40 → first carries 36 bytes, then 40, then 24 = 100
    const payload = new Uint8Array(100);
    for (let i = 0; i < payload.length; i++) payload[i] = (i * 7) & 0xff;

    let seq = 0;
    const packets = buildFragmentPackets(0, payload, () => seq++, 40);
    expect(packets.length).toBe(3);

    // Each packet should begin with [00 0d][seq BE u16]
    expect(packets[0]?.[0]).toBe(0x00);
    expect(packets[0]?.[1]).toBe(0x0d); // Fragment1 = 13 = 0x0d
    expect(packets[1]?.[1]).toBe(0x0d);
    expect(packets[2]?.[1]).toBe(0x0d);

    // Strip the [opcode][seq] header from each packet and feed to FragmentBuffer
    const buf = new FragmentBuffer();
    let assembled: Uint8Array | null = null;
    for (const p of packets) {
      const parsed = parseReliablePacket(p);
      const r = buf.addChunk(parsed.payload);
      if (r !== null) {
        assembled = r;
      }
    }
    expect(assembled).toEqual(payload);
  });

  it('a single-packet payload still produces a single fragment packet', () => {
    // payload fits comfortably in chunkSize - 4
    const payload = new Uint8Array([1, 2, 3, 4, 5, 6]);
    const packets = buildFragmentPackets(0, payload, () => 7, 64);
    expect(packets.length).toBe(1);
    const buf = new FragmentBuffer();
    const parsed = parseReliablePacket(packets[0] ?? new Uint8Array());
    const r = buf.addChunk(parsed.payload);
    expect(r).toEqual(payload);
  });

  it('throws on too-small chunkSize', () => {
    expect(() => buildFragmentPackets(0, new Uint8Array(10), () => 0, 4)).toThrow();
  });
});
