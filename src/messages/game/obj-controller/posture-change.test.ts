import { describe, expect, it } from 'vitest';
import { ByteStream } from '../../../archive/byte-stream.js';
import { ReadIterator } from '../../../archive/read-iterator.js';
import { PostureChangeDecoder, PostureChangeKind } from './posture-change.js';
import { ObjControllerSubtypeIds, objControllerRegistry } from './registry.js';

describe('PostureChange (CM_setPosture)', () => {
  it('has the right metadata', () => {
    expect(PostureChangeDecoder.kind).toBe('PostureChange');
    expect(PostureChangeDecoder.subtypeId).toBe(ObjControllerSubtypeIds.CM_setPosture);
    expect(PostureChangeDecoder.subtypeId).toBe(305);
  });

  it('self-registers in the subtype registry', () => {
    const found = objControllerRegistry.getById(ObjControllerSubtypeIds.CM_setPosture);
    expect(found).toBe(PostureChangeDecoder);
    expect(objControllerRegistry.getByKind(PostureChangeKind)).toBe(PostureChangeDecoder);
  });

  it('round-trips encode → decode', () => {
    const s = new ByteStream();
    PostureChangeDecoder.encode(s, { posture: 8, isClientImmediate: true });
    expect(s.toBytes().length).toBe(2);
    const d = PostureChangeDecoder.decode(new ReadIterator(s.toBytes()));
    expect(d.posture).toBe(8);
    expect(d.isClientImmediate).toBe(true);
  });

  it('encodes isClientImmediate=false as 0x00', () => {
    const s = new ByteStream();
    PostureChangeDecoder.encode(s, { posture: 0, isClientImmediate: false });
    const bytes = s.toBytes();
    expect(bytes[0]).toBe(0x00);
    expect(bytes[1]).toBe(0x00);
  });

  it('has the exact byte layout for posture=14 (Dead) immediate=true', () => {
    const s = new ByteStream();
    PostureChangeDecoder.encode(s, { posture: 14, isClientImmediate: true });
    const bytes = s.toBytes();
    expect(Array.from(bytes)).toEqual([0x0e, 0x01]);
  });
});
