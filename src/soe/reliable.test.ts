import { describe, expect, it } from 'vitest';
import {
  IncomingSequence,
  OutgoingSequence,
  buildAckAllPacket,
  buildAckPacket,
  buildReliablePacket,
  parseAckSeq,
  parseReliablePacket,
  reconstructReliableId,
} from './reliable.js';

describe('reconstructReliableId', () => {
  it('handles forward stamps within the current window', () => {
    expect(reconstructReliableId(0x0005, 0)).toBe(5);
    expect(reconstructReliableId(0xffff, 0xfffe)).toBe(0xffff);
  });

  it('handles wraparound from 0xffff to 0x0000', () => {
    expect(reconstructReliableId(0x0001, 0xffff)).toBe(0x10001);
  });

  it('detects a duplicate that came in slightly before the wrap', () => {
    expect(reconstructReliableId(0xfffe, 0x10001)).toBe(0xfffe);
  });
});

describe('buildReliablePacket / parseReliablePacket', () => {
  it('round-trips channel 0', () => {
    const payload = new Uint8Array([0x42, 0x43, 0x44]);
    const packet = buildReliablePacket(0, 0x1234, payload);
    expect(packet[0]).toBe(0x00);
    expect(packet[1]).toBe(0x09);
    expect(packet[2]).toBe(0x12);
    expect(packet[3]).toBe(0x34);
    expect(packet.subarray(4)).toEqual(payload);

    const parsed = parseReliablePacket(packet);
    expect(parsed.seq).toBe(0x1234);
    expect(parsed.payload).toEqual(payload);
  });
});

describe('buildAckPacket / buildAckAllPacket / parseAckSeq', () => {
  it('Ack1 is [00 11][seq BE u16]', () => {
    const a = buildAckPacket(0, 0xabcd);
    expect(a).toEqual(new Uint8Array([0x00, 0x11, 0xab, 0xcd]));
    expect(parseAckSeq(a)).toBe(0xabcd);
  });

  it('AckAll1 is [00 15][seq BE u16]', () => {
    const a = buildAckAllPacket(0, 0x0007);
    expect(a).toEqual(new Uint8Array([0x00, 0x15, 0x00, 0x07]));
    expect(parseAckSeq(a)).toBe(0x0007);
  });
});

describe('OutgoingSequence', () => {
  it('allocates monotonically and tracks pending', () => {
    const out = new OutgoingSequence();
    expect(out.allocate()).toBe(0);
    expect(out.allocate()).toBe(1);
    expect(out.allocate()).toBe(2);
    out.track(0, new Uint8Array([1]), 100);
    out.track(1, new Uint8Array([2]), 200);
    expect(out.pendingCount).toBe(2);
    out.ack(0);
    expect(out.pendingCount).toBe(1);
  });

  it('ackAll removes everything ≤ cumulative', () => {
    const out = new OutgoingSequence();
    for (let i = 0; i < 5; i++) {
      out.allocate();
      out.track(i, new Uint8Array([i]), 100);
    }
    expect(out.pendingCount).toBe(5);
    out.ackAll(2);
    expect(out.pendingCount).toBe(2);
  });

  it('needingResend returns only old packets', () => {
    const out = new OutgoingSequence();
    out.track(0, new Uint8Array(), 100); // age at t=2000 → 1900ms (≥1000 threshold)
    out.track(1, new Uint8Array(), 500); // age → 1500ms (≥1000)
    out.track(2, new Uint8Array(), 1500); // age → 500ms (<1000, not resent)
    const old = out.needingResend(2000, 1000);
    expect(old.length).toBe(2);
    const seqs = old.map((p) => p.seq).sort();
    expect(seqs).toEqual([0, 1]);
  });
});

describe('IncomingSequence', () => {
  it('in-order delivery from seq 0', () => {
    const inc = new IncomingSequence();
    const r0 = inc.receive(0x0000, new Uint8Array([0xa]));
    expect(r0.kind).toBe('in-order');
    if (r0.kind === 'in-order') {
      expect(r0.ackAllSeq).toBe(0);
      expect(r0.deliveries.length).toBe(1);
      expect(r0.deliveries[0]?.payload).toEqual(new Uint8Array([0xa]));
    }

    const r1 = inc.receive(0x0001, new Uint8Array([0xb]));
    expect(r1.kind).toBe('in-order');
    if (r1.kind === 'in-order') {
      expect(r1.ackAllSeq).toBe(1);
    }
  });

  it('out-of-order buffers and then drains', () => {
    const inc = new IncomingSequence();
    // Receive seq 2 first
    const r2 = inc.receive(0x0002, new Uint8Array([0xc]));
    expect(r2.kind).toBe('out-of-order');
    // Now seq 1
    const r1 = inc.receive(0x0001, new Uint8Array([0xb]));
    expect(r1.kind).toBe('out-of-order'); // still waiting for seq 0
    // Now seq 0 — drains all three
    const r0 = inc.receive(0x0000, new Uint8Array([0xa]));
    expect(r0.kind).toBe('in-order');
    if (r0.kind === 'in-order') {
      expect(r0.deliveries.length).toBe(3);
      expect(r0.deliveries[0]?.payload).toEqual(new Uint8Array([0xa]));
      expect(r0.deliveries[1]?.payload).toEqual(new Uint8Array([0xb]));
      expect(r0.deliveries[2]?.payload).toEqual(new Uint8Array([0xc]));
      expect(r0.ackAllSeq).toBe(2);
    }
  });

  it('duplicate of a delivered seq returns kind=duplicate', () => {
    const inc = new IncomingSequence();
    inc.receive(0x0000, new Uint8Array([0xa]));
    inc.receive(0x0001, new Uint8Array([0xb]));
    // Re-send seq 0 — server already moved past it
    const r = inc.receive(0x0000, new Uint8Array([0xa]));
    expect(r.kind).toBe('duplicate');
    if (r.kind === 'duplicate') {
      expect(r.ackAllSeq).toBe(1); // cumulative seq stays at last in-order = 1
    }
  });
});
