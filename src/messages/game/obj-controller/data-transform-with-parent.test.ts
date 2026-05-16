import { describe, expect, it } from 'vitest';
import { ByteStream } from '../../../archive/byte-stream.js';
import { ReadIterator } from '../../../archive/read-iterator.js';
import { NetUpdateTransformWithParentDecoder } from './data-transform-with-parent.js';

describe('NetUpdateTransformWithParentDecoder', () => {
  it('round-trips a 53-byte MessageQueueDataTransformWithParent (cell-relative)', () => {
    const data = {
      parentCell: 0xc0ffee_1234_5678n,
      syncStamp: 0x12345678,
      sequenceNumber: 7,
      rotation: { x: 0, y: 1, z: 0, w: 0 },
      position: { x: 3.5, y: 0, z: -1.25 },
      speed: 0,
      lookAtYaw: 0,
      useLookAtYaw: false,
    };
    const stream = new ByteStream();
    NetUpdateTransformWithParentDecoder.encode(stream, data);
    const bytes = stream.toBytes();
    // 8 (NetworkId) + 4 + 4 + 16 + 12 + 4 + 4 + 1 = 53
    expect(bytes.length).toBe(53);

    const decoded = NetUpdateTransformWithParentDecoder.decode(new ReadIterator(bytes));
    expect(decoded.parentCell).toBe(0xc0ffee_1234_5678n);
    expect(decoded.syncStamp).toBe(0x12345678);
    expect(decoded.sequenceNumber).toBe(7);
    expect(decoded.position.x).toBeCloseTo(3.5, 5);
    expect(decoded.position.z).toBeCloseTo(-1.25, 5);
  });
});
