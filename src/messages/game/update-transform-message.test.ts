import { describe, expect, it } from 'vitest';
import { StubByteStream, StubReadIterator } from '../../archive/_stub-byte-stream.js';
import { UpdateTransformMessage } from './update-transform-message.js';

describe('UpdateTransformMessage', () => {
  it('has the expected metadata', () => {
    expect(UpdateTransformMessage.messageName).toBe('UpdateTransformMessage');
    expect(UpdateTransformMessage.typeCrc).toBeGreaterThan(0);
  });

  it('encodes a 22-byte fixed payload in addVariable order', () => {
    // [u64 netid][i16 px][i16 py][i16 pz][i32 seq][i8 speed][i8 yaw][i8 lookYaw][i8 useLook]
    const m = new UpdateTransformMessage(
      0x0011_2233_4455_6677n,
      14000, // pos*4
      20,
      -18800,
      99,
      5,
      24,
      0,
      0,
    );
    const s = new StubByteStream();
    m.encodePayload(s);
    expect(s.toBytes().length).toBe(8 + 2 * 3 + 4 + 4); // 22

    const iter = new StubReadIterator(s.toBytes());
    const d = UpdateTransformMessage.decodePayload(iter);
    expect(iter.remaining).toBe(0);
    expect(d.networkId).toBe(0x0011_2233_4455_6677n);
    expect(d.positionX).toBe(14000);
    expect(d.positionY).toBe(20);
    expect(d.positionZ).toBe(-18800);
    expect(d.sequenceNumber).toBe(99);
    expect(d.speed).toBe(5);
    expect(d.yaw).toBe(24);
    expect(d.lookAtYaw).toBe(0);
    expect(d.useLookAtYaw).toBe(0);
  });

  it('drains trailing bytes defensively', () => {
    const m = new UpdateTransformMessage(1n, 0, 0, 0, 0, 0, 0, 0, 0);
    const s = new StubByteStream();
    m.encodePayload(s);
    const padded = new Uint8Array(s.toBytes().length + 4);
    padded.set(s.toBytes(), 0);
    const iter = new StubReadIterator(padded);
    const d = UpdateTransformMessage.decodePayload(iter);
    expect(d.networkId).toBe(1n);
    expect(iter.remaining).toBe(0);
  });
});
