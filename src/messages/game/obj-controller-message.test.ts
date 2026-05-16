import { describe, expect, it } from 'vitest';
import { ByteStream } from '../../archive/byte-stream.js';
import { ReadIterator } from '../../archive/read-iterator.js';
// Side-effect imports so the subtype registry is populated for the
// dispatch-coverage tests below. Order does not matter.
import './obj-controller/index.js';
import { ObjControllerMessage } from './obj-controller-message.js';
import { ObjControllerSubtypeIds } from './obj-controller/index.js';
import type { PostureChangeData } from './obj-controller/posture-change.js';

describe('ObjControllerMessage', () => {
  it('has the expected metadata', () => {
    expect(ObjControllerMessage.messageName).toBe('ObjControllerMessage');
    expect(ObjControllerMessage.typeCrc).toBeGreaterThan(0);
  });

  it('parses the 20-byte header in addVariable order (flags, message, networkId, value)', () => {
    const trailer = new Uint8Array([1, 2, 3, 4, 5, 6, 7]);
    const m = new ObjControllerMessage(0xdeadbeef, -1, 0x0011_2233_4455_6677n, 1.5, trailer);
    const s = new ByteStream();
    m.encodePayload(s);
    expect(s.toBytes().length).toBe(20 + trailer.length);

    const iter = new ReadIterator(s.toBytes());
    const d = ObjControllerMessage.decodePayload(iter);
    expect(d.flags).toBe(0xdeadbeef);
    expect(d.message).toBe(-1);
    expect(d.networkId).toBe(0x0011_2233_4455_6677n);
    expect(d.value).toBeCloseTo(1.5, 5);
    expect(Array.from(d.data)).toEqual(Array.from(trailer));
    expect(iter.remaining).toBe(0);
  });

  it('handles an empty trailer', () => {
    const m = new ObjControllerMessage(0, 0, 0n, 0);
    const s = new ByteStream();
    m.encodePayload(s);
    expect(s.toBytes().length).toBe(20);
    const d = ObjControllerMessage.decodePayload(new ReadIterator(s.toBytes()));
    expect(d.data.length).toBe(0);
  });

  it('attaches decodedSubtype=null for unknown subtypes and surfaces subtypeCrcHex', () => {
    const trailer = new Uint8Array([0xaa, 0xbb]);
    const m = new ObjControllerMessage(0, 0x7fff_0001, 0n, 0, trailer);
    const s = new ByteStream();
    m.encodePayload(s);
    const d = ObjControllerMessage.decodePayload(new ReadIterator(s.toBytes()));
    expect(d.decodedSubtype).toBeNull();
    // 0x7fff_0001 is unsigned-hex representation
    expect(d.subtypeCrcHex).toBe('0x7fff0001');
    // The opaque trailer is still available
    expect(Array.from(d.data)).toEqual([0xaa, 0xbb]);
  });

  it('hexifies negative messages as unsigned 4-byte hex', () => {
    const m = new ObjControllerMessage(0, -1, 0n, 0);
    const s = new ByteStream();
    m.encodePayload(s);
    const d = ObjControllerMessage.decodePayload(new ReadIterator(s.toBytes()));
    expect(d.subtypeCrcHex).toBe('0xffffffff');
  });

  it('dispatches PostureChange (CM_setPosture=305) and exposes decodedSubtype', () => {
    // Build a header + a 2-byte PostureChange trailer (posture=8 Sitting, immediate=true).
    const m = new ObjControllerMessage(
      0,
      ObjControllerSubtypeIds.CM_setPosture,
      0x0011_2233_4455_6677n,
      0,
      new Uint8Array([0x08, 0x01]),
    );
    const s = new ByteStream();
    m.encodePayload(s);
    const d = ObjControllerMessage.decodePayload(new ReadIterator(s.toBytes()));
    expect(d.decodedSubtype).not.toBeNull();
    expect(d.decodedSubtype?.kind).toBe('PostureChange');
    const data = d.decodedSubtype?.data as PostureChangeData;
    expect(data.posture).toBe(8);
    expect(data.isClientImmediate).toBe(true);
    // The raw trailer must still be available
    expect(Array.from(d.data)).toEqual([0x08, 0x01]);
  });

  it('round-trips through encodePayload/decodePayload with the subtype dispatch attached', () => {
    const trailerBytes = new Uint8Array([0x03, 0x00]); // posture=3 (Prone), immediate=false
    const m = new ObjControllerMessage(
      0xf,
      ObjControllerSubtypeIds.CM_setPosture,
      42n,
      0.5,
      trailerBytes,
    );
    const s = new ByteStream();
    m.encodePayload(s);
    const d = ObjControllerMessage.decodePayload(new ReadIterator(s.toBytes()));
    // Re-encode the decoded message — bytes should match.
    const s2 = new ByteStream();
    d.encodePayload(s2);
    expect(Array.from(s2.toBytes())).toEqual(Array.from(s.toBytes()));
  });
});
