import { describe, expect, it } from 'vitest';
import { ByteStream } from '../../../archive/byte-stream.js';
import { ReadIterator } from '../../../archive/read-iterator.js';
import { CraftingSlotAssignDecoder, CraftingSlotAssignKind } from './crafting-slot-assign.js';
import { ObjControllerSubtypeIds, objControllerRegistry } from './registry.js';

describe('CraftingSlotAssign (CM_fillSchematicSlotMessage)', () => {
  it('has the right metadata', () => {
    expect(CraftingSlotAssignDecoder.kind).toBe('CraftingSlotAssign');
    expect(CraftingSlotAssignDecoder.subtypeId).toBe(
      ObjControllerSubtypeIds.CM_fillSchematicSlotMessage,
    );
    expect(CraftingSlotAssignDecoder.subtypeId).toBe(263);
  });

  it('self-registers in the subtype registry', () => {
    const found = objControllerRegistry.getById(
      ObjControllerSubtypeIds.CM_fillSchematicSlotMessage,
    );
    expect(found).toBe(CraftingSlotAssignDecoder);
    expect(objControllerRegistry.getByKind(CraftingSlotAssignKind)).toBe(CraftingSlotAssignDecoder);
  });

  it('round-trips encode → decode', () => {
    const s = new ByteStream();
    CraftingSlotAssignDecoder.encode(s, {
      ingredientId: 0xc0de_babe_1234n,
      slotIndex: 2,
      optionIndex: 1,
      sequenceId: 0x42,
    });
    // 8 (NetworkId) + 4 (i32) + 4 (i32) + 1 (u8) = 17 bytes
    expect(s.toBytes().length).toBe(17);
    const d = CraftingSlotAssignDecoder.decode(new ReadIterator(s.toBytes()));
    expect(d.ingredientId).toBe(0xc0de_babe_1234n);
    expect(d.slotIndex).toBe(2);
    expect(d.optionIndex).toBe(1);
    expect(d.sequenceId).toBe(0x42);
  });

  it('has the exact byte layout for a minimal assign', () => {
    const s = new ByteStream();
    CraftingSlotAssignDecoder.encode(s, {
      ingredientId: 0n,
      slotIndex: 0,
      optionIndex: 0,
      sequenceId: 0,
    });
    expect(Array.from(s.toBytes())).toEqual([
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0, // NetworkId
      0,
      0,
      0,
      0, // slotIndex
      0,
      0,
      0,
      0, // optionIndex
      0, // sequenceId
    ]);
  });

  it('handles negative slot/option indices for fuzz safety', () => {
    const s = new ByteStream();
    CraftingSlotAssignDecoder.encode(s, {
      ingredientId: 0x100n,
      slotIndex: -1,
      optionIndex: -1,
      sequenceId: 255,
    });
    const d = CraftingSlotAssignDecoder.decode(new ReadIterator(s.toBytes()));
    expect(d.slotIndex).toBe(-1);
    expect(d.optionIndex).toBe(-1);
    expect(d.sequenceId).toBe(255);
  });
});
