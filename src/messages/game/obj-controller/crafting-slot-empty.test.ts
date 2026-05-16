import { describe, expect, it } from 'vitest';
import { ByteStream } from '../../../archive/byte-stream.js';
import { ReadIterator } from '../../../archive/read-iterator.js';
import { CraftingSlotEmptyDecoder, CraftingSlotEmptyKind } from './crafting-slot-empty.js';
import { ObjControllerSubtypeIds, objControllerRegistry } from './registry.js';

describe('CraftingSlotEmpty (CM_emptySchematicSlotMessage)', () => {
  it('has the right metadata', () => {
    expect(CraftingSlotEmptyDecoder.kind).toBe('CraftingSlotEmpty');
    expect(CraftingSlotEmptyDecoder.subtypeId).toBe(
      ObjControllerSubtypeIds.CM_emptySchematicSlotMessage,
    );
    expect(CraftingSlotEmptyDecoder.subtypeId).toBe(264);
  });

  it('self-registers in the subtype registry', () => {
    const found = objControllerRegistry.getById(
      ObjControllerSubtypeIds.CM_emptySchematicSlotMessage,
    );
    expect(found).toBe(CraftingSlotEmptyDecoder);
    expect(objControllerRegistry.getByKind(CraftingSlotEmptyKind)).toBe(CraftingSlotEmptyDecoder);
  });

  it('round-trips encode → decode', () => {
    const s = new ByteStream();
    CraftingSlotEmptyDecoder.encode(s, {
      slotIndex: 3,
      targetContainer: 0xabcdef_1234n,
      sequenceId: 0x10,
    });
    // 4 (i32) + 8 (NetworkId) + 1 (u8) = 13 bytes
    expect(s.toBytes().length).toBe(13);
    const d = CraftingSlotEmptyDecoder.decode(new ReadIterator(s.toBytes()));
    expect(d.slotIndex).toBe(3);
    expect(d.targetContainer).toBe(0xabcdef_1234n);
    expect(d.sequenceId).toBe(0x10);
  });

  it('encodes fields in the documented order (slot then container then seq)', () => {
    const s = new ByteStream();
    CraftingSlotEmptyDecoder.encode(s, {
      slotIndex: 0x01020304,
      targetContainer: 0n,
      sequenceId: 0xff,
    });
    const bytes = Array.from(s.toBytes());
    // i32 LE: 04 03 02 01
    expect(bytes.slice(0, 4)).toEqual([0x04, 0x03, 0x02, 0x01]);
    // NetworkId: 8 zero bytes
    expect(bytes.slice(4, 12)).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
    // sequenceId: ff
    expect(bytes[12]).toBe(0xff);
  });
});
