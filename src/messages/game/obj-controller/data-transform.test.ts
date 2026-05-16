import { describe, expect, it } from 'vitest';
import { ByteStream } from '../../../archive/byte-stream.js';
import { ReadIterator } from '../../../archive/read-iterator.js';
import { NetUpdateTransformDecoder } from './data-transform.js';

describe('NetUpdateTransformDecoder', () => {
  it('round-trips a 45-byte MessageQueueDataTransform', () => {
    const data = {
      syncStamp: 0x12345678,
      sequenceNumber: 7,
      rotation: { x: 0, y: 1, z: 0, w: 0 },
      position: { x: 3500, y: 8.5, z: -4800.25 },
      speed: 0,
      lookAtYaw: 0,
      useLookAtYaw: false,
    };
    const stream = new ByteStream();
    NetUpdateTransformDecoder.encode(stream, data);
    const bytes = stream.toBytes();
    // 4 (u32) + 4 (i32) + 16 (quat) + 12 (vec3) + 4 (speed) + 4 (lookAtYaw) + 1 (useLookAtYaw) = 45
    expect(bytes.length).toBe(45);

    const decoded = NetUpdateTransformDecoder.decode(new ReadIterator(bytes));
    expect(decoded.syncStamp).toBe(0x12345678);
    expect(decoded.sequenceNumber).toBe(7);
    expect(decoded.rotation).toEqual({ x: 0, y: 1, z: 0, w: 0 });
    expect(decoded.position.x).toBeCloseTo(3500, 5);
    expect(decoded.position.y).toBeCloseTo(8.5, 5);
    expect(decoded.position.z).toBeCloseTo(-4800.25, 5);
    expect(decoded.speed).toBe(0);
    expect(decoded.useLookAtYaw).toBe(false);
  });

  it('round-trips a negative sequenceNumber (teleport lockout signal from server)', () => {
    const data = {
      syncStamp: 0,
      sequenceNumber: -5,
      rotation: { x: 0, y: 0, z: 0, w: 1 },
      position: { x: 0, y: 0, z: 0 },
      speed: 0,
      lookAtYaw: 0,
      useLookAtYaw: false,
    };
    const stream = new ByteStream();
    NetUpdateTransformDecoder.encode(stream, data);
    const decoded = NetUpdateTransformDecoder.decode(new ReadIterator(stream.toBytes()));
    expect(decoded.sequenceNumber).toBe(-5);
  });

  it('round-trips useLookAtYaw=true', () => {
    const data = {
      syncStamp: 1,
      sequenceNumber: 1,
      rotation: { x: 0, y: 0, z: 0, w: 1 },
      position: { x: 0, y: 0, z: 0 },
      speed: 0,
      lookAtYaw: 1.5,
      useLookAtYaw: true,
    };
    const stream = new ByteStream();
    NetUpdateTransformDecoder.encode(stream, data);
    const decoded = NetUpdateTransformDecoder.decode(new ReadIterator(stream.toBytes()));
    expect(decoded.useLookAtYaw).toBe(true);
    expect(decoded.lookAtYaw).toBeCloseTo(1.5, 5);
  });
});
