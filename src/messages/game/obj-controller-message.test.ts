import { describe, expect, it } from 'vitest';
import { ByteStream } from '../../archive/byte-stream.js';
import { ReadIterator } from '../../archive/read-iterator.js';
import { ObjControllerMessage } from './obj-controller-message.js';

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
});
