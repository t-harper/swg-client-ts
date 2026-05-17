import { describe, expect, it } from 'vitest';
import { EncryptMethod } from '../types.js';
import type { EncryptionParams } from '../types.js';
import { SoeConnection } from './connection.js';

/**
 * Build a synthetic 17-byte SessionResponse for the given params so two
 * `SoeConnection`s can negotiate without a real socket.
 */
function buildSynthConfirm(params: EncryptionParams): Uint8Array {
  const out = new Uint8Array(17);
  out[0] = 0;
  out[1] = 2;
  out[2] = (params.connectionCode >>> 24) & 0xff;
  out[3] = (params.connectionCode >>> 16) & 0xff;
  out[4] = (params.connectionCode >>> 8) & 0xff;
  out[5] = params.connectionCode & 0xff;
  out[6] = (params.encryptCode >>> 24) & 0xff;
  out[7] = (params.encryptCode >>> 16) & 0xff;
  out[8] = (params.encryptCode >>> 8) & 0xff;
  out[9] = params.encryptCode & 0xff;
  out[10] = params.crcBytes;
  out[11] = params.encryptMethods[0];
  out[12] = params.encryptMethods[1];
  out[13] = (params.maxRawPacketSize >>> 24) & 0xff;
  out[14] = (params.maxRawPacketSize >>> 16) & 0xff;
  out[15] = (params.maxRawPacketSize >>> 8) & 0xff;
  out[16] = params.maxRawPacketSize & 0xff;
  return out;
}

describe('SoeConnection send-side fragmentation', () => {
  const params: EncryptionParams = {
    encryptCode: 0xdeadbeef,
    connectionCode: 0x12345678,
    crcBytes: 2,
    encryptMethods: [EncryptMethod.UserSupplied, EncryptMethod.Xor],
    maxRawPacketSize: 496,
  };
  const synthConfirm = buildSynthConfirm(params);

  it('small payloads take the single-packet fast path (no Fragment1 opcode)', () => {
    const sentDatagrams: Uint8Array[] = [];
    const sender = new SoeConnection({
      endpoint: { host: '127.0.0.1', port: 1 },
      connectionCode: params.connectionCode,
      onAppMessage: () => {
        /* no-op */
      },
    });
    sender.testSendOverride = (bytes) => {
      sentDatagrams.push(new Uint8Array(bytes));
    };
    sender.testInjectSessionResponse(synthConfirm);

    // A typical ~30-byte payload should produce exactly one cooked datagram
    // whose underlying SOE opcode is Reliable1 (0x09), NOT Fragment1 (0x0d).
    const smallPayload = new Uint8Array(30);
    for (let i = 0; i < smallPayload.length; i++) smallPayload[i] = i;
    sender.sendApp(smallPayload);

    expect(sentDatagrams.length).toBe(1);
    const d = sentDatagrams[0] ?? new Uint8Array();
    expect(d[0]).toBe(0x00);
    expect(d[1]).toBe(0x09);
  });

  it('payloads above maxDataBytes split across multiple Fragment1 packets', () => {
    const sentDatagrams: Uint8Array[] = [];
    const sender = new SoeConnection({
      endpoint: { host: '127.0.0.1', port: 1 },
      connectionCode: params.connectionCode,
      onAppMessage: () => {
        /* no-op */
      },
    });
    sender.testSendOverride = (bytes) => {
      sentDatagrams.push(new Uint8Array(bytes));
    };
    sender.testInjectSessionResponse(synthConfirm);

    // 2 KB payload — well above maxDataBytes (489 for SWG defaults)
    const bigPayload = new Uint8Array(2048);
    for (let i = 0; i < bigPayload.length; i++) bigPayload[i] = (i * 37 + 11) & 0xff;
    sender.sendApp(bigPayload);

    expect(sentDatagrams.length).toBeGreaterThan(1);
    for (const d of sentDatagrams) {
      expect(d[0]).toBe(0x00);
      expect(d[1]).toBe(0x0d); // Fragment1
      expect(d.length).toBeLessThanOrEqual(params.maxRawPacketSize);
    }
  });

  it('a peer SoeConnection reassembles the full payload from received fragments', () => {
    const sentDatagrams: Uint8Array[] = [];
    const sender = new SoeConnection({
      endpoint: { host: '127.0.0.1', port: 1 },
      connectionCode: params.connectionCode,
      onAppMessage: () => {
        /* no-op */
      },
    });
    sender.testSendOverride = (bytes) => {
      sentDatagrams.push(new Uint8Array(bytes));
    };
    sender.testInjectSessionResponse(synthConfirm);

    const received: Uint8Array[] = [];
    const receiver = new SoeConnection({
      endpoint: { host: '127.0.0.1', port: 1 },
      connectionCode: params.connectionCode,
      onAppMessage: (m) => received.push(new Uint8Array(m)),
    });
    receiver.testSendOverride = () => {
      /* swallow AckAlls */
    };
    receiver.testInjectSessionResponse(synthConfirm);

    // Use a binary pattern that doesn't compress well so the encrypted
    // datagram size really does hit the maxRawPacketSize ceiling — exercises
    // the worst-case sizing of maxDataBytesForFragment.
    const bigPayload = new Uint8Array(2048);
    for (let i = 0; i < bigPayload.length; i++) bigPayload[i] = (i * 251 + 13) & 0xff;
    sender.sendApp(bigPayload);

    expect(sentDatagrams.length).toBeGreaterThan(1);

    // Hand each cooked datagram to the receiver in order
    for (const d of sentDatagrams) {
      receiver.testInjectDatagram(d);
    }

    expect(received.length).toBe(1);
    expect(received[0]).toEqual(bigPayload);
  });

  it('round-trips a ~1KB ClientCreateCharacter-sized payload (just under threshold)', () => {
    const sentDatagrams: Uint8Array[] = [];
    const sender = new SoeConnection({
      endpoint: { host: '127.0.0.1', port: 1 },
      connectionCode: params.connectionCode,
      onAppMessage: () => {
        /* no-op */
      },
    });
    sender.testSendOverride = (bytes) => {
      sentDatagrams.push(new Uint8Array(bytes));
    };
    sender.testInjectSessionResponse(synthConfirm);

    const received: Uint8Array[] = [];
    const receiver = new SoeConnection({
      endpoint: { host: '127.0.0.1', port: 1 },
      connectionCode: params.connectionCode,
      onAppMessage: (m) => received.push(new Uint8Array(m)),
    });
    receiver.testSendOverride = () => {
      /* swallow AckAlls */
    };
    receiver.testInjectSessionResponse(synthConfirm);

    // 1024 bytes — well over the 489-byte single-packet threshold; should fragment
    const payload = new Uint8Array(1024);
    for (let i = 0; i < payload.length; i++) payload[i] = (i * 199 + 31) & 0xff;
    sender.sendApp(payload);

    expect(sentDatagrams.length).toBeGreaterThan(1);
    for (const d of sentDatagrams) {
      expect(d[1]).toBe(0x0d);
    }

    for (const d of sentDatagrams) {
      receiver.testInjectDatagram(d);
    }

    expect(received.length).toBe(1);
    expect(received[0]).toEqual(payload);
  });

  it('chained fragments carry strictly monotonic seq numbers (allocated from OutgoingSequence)', () => {
    const sentDatagrams: Uint8Array[] = [];
    const sender = new SoeConnection({
      endpoint: { host: '127.0.0.1', port: 1 },
      connectionCode: params.connectionCode,
      onAppMessage: () => {
        /* no-op */
      },
    });
    sender.testSendOverride = (bytes) => {
      sentDatagrams.push(new Uint8Array(bytes));
    };
    sender.testInjectSessionResponse(synthConfirm);

    const received: Uint8Array[] = [];
    const receiver = new SoeConnection({
      endpoint: { host: '127.0.0.1', port: 1 },
      connectionCode: params.connectionCode,
      onAppMessage: (m) => received.push(new Uint8Array(m)),
    });
    receiver.testSendOverride = () => {
      /* swallow AckAlls */
    };
    receiver.testInjectSessionResponse(synthConfirm);

    // First a small send to bump the outgoing seq counter to 1
    const small = new Uint8Array([0x01, 0x02, 0x03]);
    sender.sendApp(small);
    expect(sentDatagrams.length).toBe(1);

    // Then a big send — the fragments should get seqs 1, 2, 3, ... (in order).
    // We verify monotonicity at the receiver, since seq bytes are encrypted on
    // the wire (XOR pass operates from offset 2; only [00 opcode] is in the clear).
    const big = new Uint8Array(1500);
    for (let i = 0; i < big.length; i++) big[i] = (i + 1) & 0xff;
    const baseCount = sentDatagrams.length;
    sender.sendApp(big);
    const fragments = sentDatagrams.slice(baseCount);
    expect(fragments.length).toBeGreaterThan(1);

    // Push the small one first so the receiver advances expectedId to 1, then
    // the fragments which should be 1, 2, 3, ...
    receiver.testInjectDatagram(sentDatagrams[0] ?? new Uint8Array());
    for (const f of fragments) {
      receiver.testInjectDatagram(f);
    }
    // If seqs were not strictly monotonic-from-1, the IncomingSequence would
    // either buffer out-of-order or drop duplicates and reassembly would fail.
    expect(received.length).toBe(2);
    expect(received[0]).toEqual(small);
    expect(received[1]).toEqual(big);
  });
});
