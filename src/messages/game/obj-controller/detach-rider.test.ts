import { describe, expect, it } from 'vitest';
import { ByteStream } from '../../../archive/byte-stream.js';
import { ReadIterator } from '../../../archive/read-iterator.js';
import { DetachRiderDecoder, DetachRiderKind } from './detach-rider.js';
import { ObjControllerSubtypeIds, objControllerRegistry } from './registry.js';

describe('DetachRider (CM_detachRiderForMount)', () => {
  it('has the right metadata', () => {
    expect(DetachRiderDecoder.kind).toBe('DetachRider');
    expect(DetachRiderDecoder.subtypeId).toBe(ObjControllerSubtypeIds.CM_detachRiderForMount);
    expect(DetachRiderDecoder.subtypeId).toBe(541);
  });

  it('self-registers in the subtype registry', () => {
    const found = objControllerRegistry.getById(ObjControllerSubtypeIds.CM_detachRiderForMount);
    expect(found).toBe(DetachRiderDecoder);
    expect(objControllerRegistry.getByKind(DetachRiderKind)).toBe(DetachRiderDecoder);
  });

  it('round-trips a NetworkId trailer', () => {
    const s = new ByteStream();
    DetachRiderDecoder.encode(s, { riderId: 0x1234_5678_9abc_def0n });
    expect(s.toBytes().length).toBe(8);
    const d = DetachRiderDecoder.decode(new ReadIterator(s.toBytes()));
    expect(d.riderId).toBe(0x1234_5678_9abc_def0n);
  });

  it('has the exact byte layout for riderId=1', () => {
    const s = new ByteStream();
    DetachRiderDecoder.encode(s, { riderId: 1n });
    const bytes = s.toBytes();
    expect(Array.from(bytes)).toEqual([0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]);
  });
});
