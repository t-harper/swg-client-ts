import { describe, expect, it } from 'vitest';
import { ByteStream } from '../../../archive/byte-stream.js';
import { ReadIterator } from '../../../archive/read-iterator.js';
import { CraftingStartDecoder, CraftingStartKind } from './crafting-start.js';
import { ObjControllerSubtypeIds, objControllerRegistry } from './registry.js';

describe('CraftingStart (CM_requestCraftingSession)', () => {
  it('has the right metadata', () => {
    expect(CraftingStartDecoder.kind).toBe('CraftingStart');
    expect(CraftingStartDecoder.subtypeId).toBe(ObjControllerSubtypeIds.CM_requestCraftingSession);
    expect(CraftingStartDecoder.subtypeId).toBe(271);
  });

  it('self-registers in the subtype registry', () => {
    const found = objControllerRegistry.getById(ObjControllerSubtypeIds.CM_requestCraftingSession);
    expect(found).toBe(CraftingStartDecoder);
    expect(objControllerRegistry.getByKind(CraftingStartKind)).toBe(CraftingStartDecoder);
  });

  it('round-trips encode → decode', () => {
    const s = new ByteStream();
    CraftingStartDecoder.encode(s, { stationId: 0xabcd_1234n, sequenceId: 7 });
    // 8 bytes (NetworkId) + 1 byte (u8 seq) = 9 bytes
    expect(s.toBytes().length).toBe(9);
    const d = CraftingStartDecoder.decode(new ReadIterator(s.toBytes()));
    expect(d.stationId).toBe(0xabcd_1234n);
    expect(d.sequenceId).toBe(7);
  });

  it('has the exact byte layout', () => {
    const s = new ByteStream();
    CraftingStartDecoder.encode(s, { stationId: 0x0102030405060708n, sequenceId: 0xff });
    // i64 LE: 08 07 06 05 04 03 02 01; u8: ff
    expect(Array.from(s.toBytes())).toEqual([0x08, 0x07, 0x06, 0x05, 0x04, 0x03, 0x02, 0x01, 0xff]);
  });
});
