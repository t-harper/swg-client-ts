import { describe, expect, it } from 'vitest';
import { ByteStream } from '../../../archive/byte-stream.js';
import { ReadIterator } from '../../../archive/read-iterator.js';
import { CraftingFinishDecoder, CraftingFinishKind } from './crafting-finish.js';
import { ObjControllerSubtypeIds, objControllerRegistry } from './registry.js';

describe('CraftingFinish (CM_createPrototype)', () => {
  it('has the right metadata', () => {
    expect(CraftingFinishDecoder.kind).toBe('CraftingFinish');
    expect(CraftingFinishDecoder.subtypeId).toBe(ObjControllerSubtypeIds.CM_createPrototype);
    expect(CraftingFinishDecoder.subtypeId).toBe(266);
  });

  it('self-registers in the subtype registry', () => {
    const found = objControllerRegistry.getById(ObjControllerSubtypeIds.CM_createPrototype);
    expect(found).toBe(CraftingFinishDecoder);
    expect(objControllerRegistry.getByKind(CraftingFinishKind)).toBe(CraftingFinishDecoder);
  });

  it('round-trips encode → decode', () => {
    const s = new ByteStream();
    CraftingFinishDecoder.encode(s, { sequenceId: 0xa5 });
    expect(s.toBytes().length).toBe(1);
    const d = CraftingFinishDecoder.decode(new ReadIterator(s.toBytes()));
    expect(d.sequenceId).toBe(0xa5);
  });

  it('has the exact byte layout for sequenceId=0', () => {
    const s = new ByteStream();
    CraftingFinishDecoder.encode(s, { sequenceId: 0 });
    expect(Array.from(s.toBytes())).toEqual([0]);
  });
});
