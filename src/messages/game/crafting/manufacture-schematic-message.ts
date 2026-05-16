/**
 * ManufactureSchematic / DraftSlots (CM_draftSlotsMessage = 259) — server-to-client.
 *
 * After the player selects a draft schematic, the server creates an in-progress
 * `ManufactureSchematicObject` and immediately pushes its slot layout via
 * `MessageQueueDraftSlots`. This is the "ingredient assignment panel" the
 * client renders: each slot specifies a name (localized via `StringId`), an
 * `optional` flag, the list of valid ingredient options (resource class /
 * specific item / template), and an optional `hardpoint` string for component
 * slots.
 *
 * This is NOT a top-level `GameNetworkMessage` — the wire payload here is the
 * variable-length trailer of an `ObjControllerMessage` whose `message` field
 * is `CM_draftSlotsMessage`. The parent's 20-byte header is peeled off
 * upstream.
 *
 * Wire layout (trailer only):
 *   [NetworkId (i64 LE)]   toolId
 *   [NetworkId (i64 LE)]   manfSchemId         the in-flight ManufactureSchematicObject NetworkId
 *   [NetworkId (i64 LE)]   prototypeId         output prototype NetworkId (0 until createPrototype)
 *   [i32]                  volume
 *   [bool (1 byte)]        canManufacture
 *   [i32]                  slotCount
 *   for each slot:
 *     [StringId]           name                table+index+text triple
 *     [bool (1 byte)]      optional
 *     [i32]                optionCount
 *     for each option:
 *       [StringId]         name
 *       [UnicodeString]    ingredient          template/resource-class identifier
 *       [u8]               type                Crafting::IngredientType enum (see below)
 *       [i32]              amountNeeded
 *     if any option is IT_item (1) or IT_template (2):
 *       [std::string]      hardpoint
 *
 * StringId wire layout (3 fields):
 *   [std::string]   table
 *   [u32]           index             (server sends current text-index; we send 0 on encode)
 *   [std::string]   text              (the text key within the table)
 *
 * Crafting::IngredientType enum (uint8):
 *   0  IT_none
 *   1  IT_item              specific item
 *   2  IT_template          item created from template
 *   3  IT_resourceType
 *   4  IT_resourceClass
 *   5  IT_templateGeneric
 *   6  IT_schematic
 *   7  IT_schematicGeneric
 *
 * Source:
 *   /home/tharper/code/swg-main/src/engine/shared/library/sharedNetworkMessages/src/shared/clientGameServer/MessageQueueDraftSlots.cpp:35-91
 *   /home/tharper/code/swg-main/src/engine/shared/library/sharedNetworkMessages/src/shared/clientGameServer/MessageQueueDraftSlotsDataArchive.cpp:22-77
 *   /home/tharper/code/swg-main/src/engine/shared/library/sharedNetworkMessages/src/shared/clientGameServer/MessageQueueDraftSlotsDataOptionArchive.cpp:20-43
 *   /home/tharper/code/swg-main/src/external/ours/library/localizationArchive/src/shared/StringIdArchive.cpp:24-54
 */

import type { IByteStream, IReadIterator } from '../../../archive/interface.js';
import { NetworkIdCodec } from '../../../archive/network-id.js';
import { readStdString, writeStdString } from '../../../archive/string.js';
import { readUnicodeString, writeUnicodeString } from '../../../archive/unicode-string.js';
import type { NetworkId } from '../../../types.js';
import {
  ObjControllerSubtypeIds,
  registerObjControllerSubtype,
} from '../obj-controller/registry.js';

/**
 * Crafting::IngredientType (uint8 on the wire).
 *
 * Source: sharedGame/src/shared/core/CraftingData.h lines 159-170.
 */
export const CraftingIngredientType = {
  None: 0,
  Item: 1,
  Template: 2,
  ResourceType: 3,
  ResourceClass: 4,
  TemplateGeneric: 5,
  Schematic: 6,
  SchematicGeneric: 7,
} as const;

export type CraftingIngredientTypeValue =
  (typeof CraftingIngredientType)[keyof typeof CraftingIngredientType];

/** A `StringId` triple (table, index, text) — wire layout per StringIdArchive. */
export interface StringIdValue {
  table: string;
  index: number;
  text: string;
}

export interface ManufactureSchematicSlotOption {
  name: StringIdValue;
  /** Template / resource-class identifier (Unicode string on the wire). */
  ingredient: string;
  type: number;
  amountNeeded: number;
}

export interface ManufactureSchematicSlot {
  name: StringIdValue;
  optional: boolean;
  options: ManufactureSchematicSlotOption[];
  /**
   * For component slots (any option with type `Item` or `Template`), a
   * hardpoint identifier on the parent appearance. Empty string when not
   * a component slot.
   */
  hardpoint: string;
}

export interface ManufactureSchematicData {
  toolId: NetworkId;
  /** NetworkId of the in-flight ManufactureSchematicObject. */
  manfSchemId: NetworkId;
  /** NetworkId of the eventual prototype; `0n` until createPrototype is called. */
  prototypeId: NetworkId;
  /** Number of items produced per craft attempt; default 1, can be > 1 for batch crafts. */
  volume: number;
  /** True when the schematic can be turned into a manufacturing schematic (batched factory craft). */
  canManufacture: boolean;
  slots: ManufactureSchematicSlot[];
}

export const ManufactureSchematicKind = 'ManufactureSchematic' as const;

function writeStringId(stream: IByteStream, value: StringIdValue): void {
  writeStdString(stream, value.table);
  stream.writeU32(value.index);
  writeStdString(stream, value.text);
}

function readStringId(iter: IReadIterator): StringIdValue {
  const table = readStdString(iter);
  const index = iter.readU32();
  const text = readStdString(iter);
  return { table, index, text };
}

function writeSlotOption(stream: IByteStream, option: ManufactureSchematicSlotOption): void {
  writeStringId(stream, option.name);
  writeUnicodeString(stream, option.ingredient);
  stream.writeU8(option.type);
  stream.writeI32(option.amountNeeded);
}

function readSlotOption(iter: IReadIterator): ManufactureSchematicSlotOption {
  const name = readStringId(iter);
  const ingredient = readUnicodeString(iter);
  const type = iter.readU8();
  const amountNeeded = iter.readI32();
  return { name, ingredient, type, amountNeeded };
}

function slotIsComponent(slot: ManufactureSchematicSlot): boolean {
  for (const opt of slot.options) {
    if (opt.type === CraftingIngredientType.Item || opt.type === CraftingIngredientType.Template) {
      return true;
    }
  }
  return false;
}

function writeSlot(stream: IByteStream, slot: ManufactureSchematicSlot): void {
  writeStringId(stream, slot.name);
  stream.writeBool(slot.optional);
  stream.writeI32(slot.options.length);
  for (const opt of slot.options) {
    writeSlotOption(stream, opt);
  }
  // The hardpoint trailer is ONLY written when at least one option is a
  // component (item or template) — matches MessageQueueDraftSlotsDataArchive.cpp.
  if (slotIsComponent(slot)) {
    writeStdString(stream, slot.hardpoint);
  }
}

function readSlot(iter: IReadIterator): ManufactureSchematicSlot {
  const name = readStringId(iter);
  const optional = iter.readBool();
  const optionCount = iter.readI32();
  if (optionCount < 0) {
    throw new RangeError(`ManufactureSchematic slot decode: negative option count ${optionCount}`);
  }
  const options: ManufactureSchematicSlotOption[] = [];
  let componentSlot = false;
  for (let i = 0; i < optionCount; i++) {
    const option = readSlotOption(iter);
    options.push(option);
    if (
      option.type === CraftingIngredientType.Item ||
      option.type === CraftingIngredientType.Template
    ) {
      componentSlot = true;
    }
  }
  const hardpoint = componentSlot ? readStdString(iter) : '';
  return { name, optional, options, hardpoint };
}

export const ManufactureSchematicDecoder = registerObjControllerSubtype<ManufactureSchematicData>({
  kind: ManufactureSchematicKind,
  subtypeId: ObjControllerSubtypeIds.CM_draftSlotsMessage,
  encode(stream: IByteStream, data: ManufactureSchematicData): void {
    NetworkIdCodec.encode(stream, data.toolId);
    NetworkIdCodec.encode(stream, data.manfSchemId);
    NetworkIdCodec.encode(stream, data.prototypeId);
    stream.writeI32(data.volume);
    stream.writeBool(data.canManufacture);
    stream.writeI32(data.slots.length);
    for (const slot of data.slots) {
      writeSlot(stream, slot);
    }
  },
  decode(iter: IReadIterator): ManufactureSchematicData {
    const toolId = NetworkIdCodec.decode(iter);
    const manfSchemId = NetworkIdCodec.decode(iter);
    const prototypeId = NetworkIdCodec.decode(iter);
    const volume = iter.readI32();
    const canManufacture = iter.readBool();
    const slotCount = iter.readI32();
    if (slotCount < 0) {
      throw new RangeError(`ManufactureSchematic decode: negative slot count ${slotCount}`);
    }
    const slots: ManufactureSchematicSlot[] = [];
    for (let i = 0; i < slotCount; i++) {
      slots.push(readSlot(iter));
    }
    return { toolId, manfSchemId, prototypeId, volume, canManufacture, slots };
  },
});
