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

  it('splits a 2KB payload across 5 packets at chunkSize=489 (SWG default)', () => {
    // 2048 bytes with chunkSize=489 → first carries (489-4)=485 + then 489+489+489+ = 1947 covered after 4 packets;
    // 4th pkt overflows actually: 485 + 489 + 489 + 489 = 1952, +96 = 2048 → 5 packets total.
    const payload = new Uint8Array(2048);
    for (let i = 0; i < payload.length; i++) payload[i] = (i * 13 + 7) & 0xff;

    let seq = 100;
    const packets = buildFragmentPackets(0, payload, () => seq++, 489);
    expect(packets.length).toBe(5);

    // First packet: [00 0d][seq=100 BE][totalLen=2048 BE u32][485 data bytes]
    const p0 = packets[0] ?? new Uint8Array();
    expect(p0.length).toBe(4 + 4 + 485);
    expect(p0[0]).toBe(0x00);
    expect(p0[1]).toBe(0x0d);
    expect(p0[2]).toBe(0x00);
    expect(p0[3]).toBe(100);
    expect(p0[4]).toBe(0x00);
    expect(p0[5]).toBe(0x00);
    expect(p0[6]).toBe(0x08);
    expect(p0[7]).toBe(0x00);

    // Subsequent packets all start [00 0d][seq][...] — no totalLen
    for (let i = 1; i < packets.length; i++) {
      const p = packets[i] ?? new Uint8Array();
      expect(p[0]).toBe(0x00);
      expect(p[1]).toBe(0x0d);
    }

    // Reassemble via FragmentBuffer and check we get the original payload
    const buf = new FragmentBuffer();
    let assembled: Uint8Array | null = null;
    for (const p of packets) {
      const parsed = parseReliablePacket(p);
      const r = buf.addChunk(parsed.payload);
      if (r !== null) assembled = r;
    }
    expect(assembled).toEqual(payload);
  });

  it('allocates strictly chained sequence numbers from the supplied allocator', () => {
    const payload = new Uint8Array(1500);
    let next = 42;
    const seqs: number[] = [];
    const packets = buildFragmentPackets(
      0,
      payload,
      () => {
        const s = next++;
        seqs.push(s);
        return s;
      },
      100,
    );
    // 1500 bytes / chunkSize=100 → first carries 96, then 100 each → ceil((1500-96)/100)=15 → 16 packets total
    expect(packets.length).toBe(16);
    expect(seqs).toEqual([42, 43, 44, 45, 46, 47, 48, 49, 50, 51, 52, 53, 54, 55, 56, 57]);

    // Verify each packet carries its own seq in [2..3] BE
    for (let i = 0; i < packets.length; i++) {
      const p = packets[i] ?? new Uint8Array();
      const wireSeq = ((p[2] ?? 0) << 8) | (p[3] ?? 0);
      expect(wireSeq).toBe(seqs[i] ?? -1);
    }
  });

  it('the concatenation of all fragment data chunks equals the input', () => {
    const payload = new Uint8Array(789);
    for (let i = 0; i < payload.length; i++) payload[i] = i & 0xff;

    const packets = buildFragmentPackets(
      0,
      payload,
      (() => {
        let s = 0;
        return () => s++;
      })(),
      80,
    );

    // First packet's data starts at offset 8 (after [00 0d][seq][totalLen])
    // Subsequent packets' data starts at offset 4
    const chunks: number[] = [];
    let firstSeen = false;
    for (const p of packets) {
      if (!firstSeen) {
        for (let i = 8; i < p.length; i++) {
          const b = p[i];
          if (b !== undefined) chunks.push(b);
        }
        firstSeen = true;
      } else {
        for (let i = 4; i < p.length; i++) {
          const b = p[i];
          if (b !== undefined) chunks.push(b);
        }
      }
    }
    expect(chunks.length).toBe(payload.length);
    for (let i = 0; i < payload.length; i++) expect(chunks[i]).toBe(payload[i]);
  });
});
