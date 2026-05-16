import { describe, expect, it } from 'vitest';
import { ByteStream } from '../../../archive/byte-stream.js';
import { ReadIterator } from '../../../archive/read-iterator.js';
import { CraftingResultDecoder, CraftingResultKind } from './crafting-result.js';
import { ObjControllerSubtypeIds, objControllerRegistry } from './registry.js';

describe('CraftingResult (CM_craftingResult)', () => {
  it('has the right metadata', () => {
    expect(CraftingResultDecoder.kind).toBe('CraftingResult');
    expect(CraftingResultDecoder.subtypeId).toBe(ObjControllerSubtypeIds.CM_craftingResult);
    expect(CraftingResultDecoder.subtypeId).toBe(268);
  });

  it('self-registers in the subtype registry', () => {
    const found = objControllerRegistry.getById(ObjControllerSubtypeIds.CM_craftingResult);
    expect(found).toBe(CraftingResultDecoder);
    expect(objControllerRegistry.getByKind(CraftingResultKind)).toBe(CraftingResultDecoder);
  });

  it('round-trips encode → decode', () => {
    const s = new ByteStream();
    CraftingResultDecoder.encode(s, {
      requestId: ObjControllerSubtypeIds.CM_requestCraftingSession,
      response: 1,
      sequenceId: 42,
    });
    expect(s.toBytes().length).toBe(9); // i32 + i32 + u8
    const d = CraftingResultDecoder.decode(new ReadIterator(s.toBytes()));
    expect(d.requestId).toBe(ObjControllerSubtypeIds.CM_requestCraftingSession);
    expect(d.response).toBe(1);
    expect(d.sequenceId).toBe(42);
  });

  it('has the exact byte layout for a typical request-session success reply', () => {
    // requestId = 271 (CM_requestCraftingSession), response = 1 (success), seq = 7
    const s = new ByteStream();
    CraftingResultDecoder.encode(s, { requestId: 271, response: 1, sequenceId: 7 });
    // 271 = 0x10F LE → 0F 01 00 00; 1 = 01 00 00 00; 7 = 07
    expect(Array.from(s.toBytes())).toEqual([0x0f, 0x01, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x07]);
  });

  it('round-trips a failure response (response = 0)', () => {
    const s = new ByteStream();
    CraftingResultDecoder.encode(s, { requestId: 266, response: 0, sequenceId: 0 });
    const d = CraftingResultDecoder.decode(new ReadIterator(s.toBytes()));
    expect(d.response).toBe(0);
  });
});
