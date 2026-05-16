import { describe, expect, it } from 'vitest';
import { ByteStream } from '../../../archive/byte-stream.js';
import { ReadIterator } from '../../../archive/read-iterator.js';
import {
  CraftSelectSchematicDecoder,
  CraftSelectSchematicKind,
} from './crafting-select-schematic.js';
import { ObjControllerSubtypeIds, objControllerRegistry } from './registry.js';

describe('CraftSelectSchematic (CM_selectDraftSchematic)', () => {
  it('has the right metadata', () => {
    expect(CraftSelectSchematicDecoder.kind).toBe('CraftSelectSchematic');
    expect(CraftSelectSchematicDecoder.subtypeId).toBe(
      ObjControllerSubtypeIds.CM_selectDraftSchematic,
    );
    expect(CraftSelectSchematicDecoder.subtypeId).toBe(270);
  });

  it('self-registers in the subtype registry', () => {
    const found = objControllerRegistry.getById(ObjControllerSubtypeIds.CM_selectDraftSchematic);
    expect(found).toBe(CraftSelectSchematicDecoder);
    expect(objControllerRegistry.getByKind(CraftSelectSchematicKind)).toBe(
      CraftSelectSchematicDecoder,
    );
  });

  it('round-trips encode → decode', () => {
    const s = new ByteStream();
    CraftSelectSchematicDecoder.encode(s, { schematicIndex: 12 });
    expect(s.toBytes().length).toBe(4);
    const d = CraftSelectSchematicDecoder.decode(new ReadIterator(s.toBytes()));
    expect(d.schematicIndex).toBe(12);
  });

  it('has the exact byte layout', () => {
    const s = new ByteStream();
    CraftSelectSchematicDecoder.encode(s, { schematicIndex: 0x12345678 });
    expect(Array.from(s.toBytes())).toEqual([0x78, 0x56, 0x34, 0x12]);
  });

  it('handles negative indices (signed I32 decode path)', () => {
    const s = new ByteStream();
    CraftSelectSchematicDecoder.encode(s, { schematicIndex: -1 });
    const d = CraftSelectSchematicDecoder.decode(new ReadIterator(s.toBytes()));
    expect(d.schematicIndex).toBe(-1);
  });
});
