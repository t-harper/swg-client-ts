import { describe, expect, it } from 'vitest';
import { ByteStream } from '../../../archive/byte-stream.js';
import { ReadIterator } from '../../../archive/read-iterator.js';
import { DetachAllRidersDecoder, DetachAllRidersKind } from './detach-all-riders.js';
import { ObjControllerSubtypeIds, objControllerRegistry } from './registry.js';

describe('DetachAllRiders (CM_detachAllRidersForMount)', () => {
  it('has the right metadata', () => {
    expect(DetachAllRidersDecoder.kind).toBe('DetachAllRiders');
    expect(DetachAllRidersDecoder.subtypeId).toBe(
      ObjControllerSubtypeIds.CM_detachAllRidersForMount,
    );
    expect(DetachAllRidersDecoder.subtypeId).toBe(1205);
  });

  it('self-registers in the subtype registry', () => {
    const found = objControllerRegistry.getById(ObjControllerSubtypeIds.CM_detachAllRidersForMount);
    expect(found).toBe(DetachAllRidersDecoder);
    expect(objControllerRegistry.getByKind(DetachAllRidersKind)).toBe(DetachAllRidersDecoder);
  });

  it('round-trips an empty trailer', () => {
    const s = new ByteStream();
    DetachAllRidersDecoder.encode(s, {});
    expect(s.toBytes().length).toBe(0);
    const d = DetachAllRidersDecoder.decode(new ReadIterator(s.toBytes()));
    expect(d).toEqual({});
  });
});
