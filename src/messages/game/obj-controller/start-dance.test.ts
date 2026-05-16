import { describe, expect, it } from 'vitest';
import { ByteStream } from '../../../archive/byte-stream.js';
import { ReadIterator } from '../../../archive/read-iterator.js';
import { ObjControllerSubtypeIds, objControllerRegistry } from './registry.js';
import { StartDanceDecoder, StartDanceKind } from './start-dance.js';

describe('StartDance (CM_setPerformanceType)', () => {
  it('has the right metadata', () => {
    expect(StartDanceDecoder.kind).toBe('StartDance');
    expect(StartDanceDecoder.subtypeId).toBe(ObjControllerSubtypeIds.CM_setPerformanceType);
    expect(StartDanceDecoder.subtypeId).toBe(352);
  });

  it('self-registers in the subtype registry', () => {
    const found = objControllerRegistry.getById(ObjControllerSubtypeIds.CM_setPerformanceType);
    expect(found).toBe(StartDanceDecoder);
    expect(objControllerRegistry.getByKind(StartDanceKind)).toBe(StartDanceDecoder);
  });

  it('round-trips encode → decode', () => {
    const s = new ByteStream();
    StartDanceDecoder.encode(s, { performanceType: 42 });
    expect(s.toBytes().length).toBe(4);
    const d = StartDanceDecoder.decode(new ReadIterator(s.toBytes()));
    expect(d.performanceType).toBe(42);
  });

  it('encodes "stop performing" (performanceType=0) as 4 zero bytes', () => {
    const s = new ByteStream();
    StartDanceDecoder.encode(s, { performanceType: 0 });
    expect(Array.from(s.toBytes())).toEqual([0, 0, 0, 0]);
  });

  it('has the exact byte layout for performanceType=7', () => {
    const s = new ByteStream();
    StartDanceDecoder.encode(s, { performanceType: 7 });
    expect(Array.from(s.toBytes())).toEqual([0x07, 0, 0, 0]);
  });

  it('handles negative signed-int values (decoder reads as i32)', () => {
    // While the server never sends a negative performance type today,
    // exercising the signed-decode path guards against any future enum
    // change that uses negative sentinel values.
    const s = new ByteStream();
    StartDanceDecoder.encode(s, { performanceType: -1 });
    const d = StartDanceDecoder.decode(new ReadIterator(s.toBytes()));
    expect(d.performanceType).toBe(-1);
  });
});
