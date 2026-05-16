import { describe, expect, it } from 'vitest';
import { ByteStream } from '../../../archive/byte-stream.js';
import { ReadIterator } from '../../../archive/read-iterator.js';
import { encodeMessage, parseHeader } from '../../base.js';
import { messageRegistry } from '../../registry.js';
import { ObjControllerMessage } from '../obj-controller-message.js';
// Side-effect import: registers the ObjControllerMessage top-level decoder.
import '../obj-controller-message.js';
import { ObjControllerSubtypeIds, objControllerRegistry } from '../obj-controller/registry.js';
import {
  CraftingIngredientType,
  type ManufactureSchematicData,
  ManufactureSchematicDecoder,
  ManufactureSchematicKind,
} from './manufacture-schematic-message.js';

describe('ManufactureSchematicMessage (CM_draftSlotsMessage)', () => {
  it('has the right metadata', () => {
    expect(ManufactureSchematicDecoder.kind).toBe('ManufactureSchematic');
    expect(ManufactureSchematicDecoder.subtypeId).toBe(
      ObjControllerSubtypeIds.CM_draftSlotsMessage,
    );
    expect(ManufactureSchematicDecoder.subtypeId).toBe(259);
  });

  it('self-registers in the subtype registry', () => {
    const found = objControllerRegistry.getById(ObjControllerSubtypeIds.CM_draftSlotsMessage);
    expect(found).toBe(ManufactureSchematicDecoder);
    expect(objControllerRegistry.getByKind(ManufactureSchematicKind)).toBe(
      ManufactureSchematicDecoder,
    );
  });

  it('round-trips encode → decode with no slots', () => {
    const data: ManufactureSchematicData = {
      toolId: 0xabcdn,
      manfSchemId: 0x1234n,
      prototypeId: 0n,
      volume: 1,
      canManufacture: false,
      slots: [],
    };
    const s = new ByteStream();
    ManufactureSchematicDecoder.encode(s, data);
    const d = ManufactureSchematicDecoder.decode(new ReadIterator(s.toBytes()));
    expect(d).toEqual(data);
  });

  it('round-trips encode → decode with a non-component slot (no hardpoint)', () => {
    const data: ManufactureSchematicData = {
      toolId: 0x42n,
      manfSchemId: 0x1234n,
      prototypeId: 0n,
      volume: 2,
      canManufacture: true,
      slots: [
        {
          name: { table: 'craft', index: 0, text: 'metal' },
          optional: false,
          options: [
            {
              name: { table: 'craft', index: 0, text: 'ferrous_metal' },
              ingredient: 'ferrous_metal',
              type: CraftingIngredientType.ResourceClass,
              amountNeeded: 25,
            },
          ],
          hardpoint: '', // not a component slot — no hardpoint expected
        },
      ],
    };
    const s = new ByteStream();
    ManufactureSchematicDecoder.encode(s, data);
    const d = ManufactureSchematicDecoder.decode(new ReadIterator(s.toBytes()));
    expect(d).toEqual(data);
  });

  it('round-trips encode → decode with a component slot (hardpoint present)', () => {
    const data: ManufactureSchematicData = {
      toolId: 0x10n,
      manfSchemId: 0x20n,
      prototypeId: 0x30n,
      volume: 1,
      canManufacture: false,
      slots: [
        {
          name: { table: 'craft', index: 0, text: 'barrel' },
          optional: true,
          options: [
            {
              name: { table: 'craft', index: 0, text: 'mark_v_barrel' },
              ingredient: 'object/tangible/component/weapon/blaster/small_blaster_barrel.iff',
              type: CraftingIngredientType.Template,
              amountNeeded: 1,
            },
          ],
          hardpoint: 'barrel_hp',
        },
      ],
    };
    const s = new ByteStream();
    ManufactureSchematicDecoder.encode(s, data);
    const d = ManufactureSchematicDecoder.decode(new ReadIterator(s.toBytes()));
    expect(d).toEqual(data);
  });

  it('round-trips encode → decode with mixed slot kinds and options', () => {
    const data: ManufactureSchematicData = {
      toolId: 0x100n,
      manfSchemId: 0x200n,
      prototypeId: 0x300n,
      volume: 3,
      canManufacture: true,
      slots: [
        // Non-component slot — no hardpoint encoded
        {
          name: { table: 'craft', index: 0, text: 'metals' },
          optional: false,
          options: [
            {
              name: { table: 'craft', index: 0, text: 'iron' },
              ingredient: 'iron',
              type: CraftingIngredientType.ResourceType,
              amountNeeded: 50,
            },
            {
              name: { table: 'craft', index: 0, text: 'ferrous' },
              ingredient: 'ferrous_metal',
              type: CraftingIngredientType.ResourceClass,
              amountNeeded: 50,
            },
          ],
          hardpoint: '',
        },
        // Component slot with Item option — hardpoint encoded
        {
          name: { table: 'craft', index: 0, text: 'gem' },
          optional: true,
          options: [
            {
              name: { table: 'craft', index: 0, text: 'krayt_pearl' },
              ingredient: 'krayt_pearl',
              type: CraftingIngredientType.Item,
              amountNeeded: 1,
            },
          ],
          hardpoint: 'gem_socket',
        },
      ],
    };
    const s = new ByteStream();
    ManufactureSchematicDecoder.encode(s, data);
    const d = ManufactureSchematicDecoder.decode(new ReadIterator(s.toBytes()));
    expect(d).toEqual(data);
  });

  it('encodes a header-only (zero-slot) form with the expected fixed prefix length', () => {
    const data: ManufactureSchematicData = {
      toolId: 0n,
      manfSchemId: 0n,
      prototypeId: 0n,
      volume: 1,
      canManufacture: false,
      slots: [],
    };
    const s = new ByteStream();
    ManufactureSchematicDecoder.encode(s, data);
    // 3 NetworkIds (24) + i32 volume (4) + bool (1) + i32 slotCount (4) = 33 bytes
    expect(s.toBytes().length).toBe(33);
  });

  it('rejects a negative slot count on decode', () => {
    // Build a buffer with valid header then negative slot count
    const s = new ByteStream();
    s.writeI64(0n); // toolId
    s.writeI64(0n); // manfSchemId
    s.writeI64(0n); // prototypeId
    s.writeI32(0); // volume
    s.writeBool(false); // canManufacture
    s.writeI32(-1); // slotCount
    expect(() => ManufactureSchematicDecoder.decode(new ReadIterator(s.toBytes()))).toThrow(
      /negative slot count/,
    );
  });

  it('dispatches through the parent ObjControllerMessage decoder', () => {
    const data: ManufactureSchematicData = {
      toolId: 0x42n,
      manfSchemId: 0x100n,
      prototypeId: 0n,
      volume: 1,
      canManufacture: false,
      slots: [],
    };
    const s = new ByteStream();
    ManufactureSchematicDecoder.encode(s, data);
    const parent = new ObjControllerMessage(
      0x01,
      ObjControllerSubtypeIds.CM_draftSlotsMessage,
      0xaaaan,
      0,
      s.toBytes(),
    );
    const bytes = encodeMessage(parent);
    const { typeCrc, payload } = parseHeader(bytes);
    const decoder = messageRegistry.getByCrc(typeCrc);
    if (!decoder) throw new Error('ObjControllerMessage decoder not registered');
    const decoded = decoder.decodePayload(payload) as ObjControllerMessage;
    expect(decoded.decodedSubtype?.kind).toBe('ManufactureSchematic');
    const decodedData = decoded.decodedSubtype?.data as ManufactureSchematicData;
    expect(decodedData.toolId).toBe(0x42n);
    expect(decodedData.manfSchemId).toBe(0x100n);
  });
});
