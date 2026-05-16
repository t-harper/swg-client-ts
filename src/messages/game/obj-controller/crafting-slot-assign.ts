/**
 * CraftingSlotAssign / CraftFillSlot (CM_fillSchematicSlotMessage = 263)
 *  — client-to-server.
 *
 * Sent when the player drags an ingredient (resource container, component
 * item, etc.) into a schematic slot in the crafting UI. Carries the
 * ingredient NetworkId, the slot index, an option index (which of the
 * slot's accepted-ingredient options this maps to), and the per-session
 * sequence id for correlation.
 *
 * On the server, `commandFuncFillCraftingSlot` (eventually) calls
 * `MessageQueueCraftFillSlot::install` to dispatch this. The reply is a
 * `MessageQueueGenericIntResponse` carried under `CM_craftingResult` with
 * `requestId = CM_fillSchematicSlotMessage`.
 *
 * The macro used is `CONTROLLER_MESSAGE_ALLOW_FROM_CLIENT_IMPLEMENTATION`,
 * confirming that the subtype is permitted to flow from client → server (most
 * subtypes are server-only).
 *
 * Wire layout (trailer only):
 *   [NetworkId (i64 LE)]   ingredientId       the item / resource container being assigned
 *   [i32]                  slotIndex          which slot in the active schematic
 *   [i32]                  optionIndex        which of the slot's options this satisfies
 *   [u8]                   sequenceId         per-session correlation id
 *
 * Source:
 *   /home/tharper/code/swg-main/src/engine/shared/library/sharedNetworkMessages/src/shared/clientGameServer/MessageQueueCraftFillSlot.cpp:32-60
 */

import type { IByteStream, IReadIterator } from '../../../archive/interface.js';
import { NetworkIdCodec } from '../../../archive/network-id.js';
import type { NetworkId } from '../../../types.js';
import { ObjControllerSubtypeIds, registerObjControllerSubtype } from './registry.js';

export interface CraftingSlotAssignData {
  /** NetworkId of the item / resource container being assigned to the slot. */
  ingredientId: NetworkId;
  /** Zero-based index of the slot within the active schematic. */
  slotIndex: number;
  /** Zero-based index of which slot-option this ingredient satisfies. */
  optionIndex: number;
  /** Per-session correlation id; echoed in the server's CM_craftingResult reply. */
  sequenceId: number;
}

export const CraftingSlotAssignKind = 'CraftingSlotAssign' as const;

export const CraftingSlotAssignDecoder = registerObjControllerSubtype<CraftingSlotAssignData>({
  kind: CraftingSlotAssignKind,
  subtypeId: ObjControllerSubtypeIds.CM_fillSchematicSlotMessage,
  encode(stream: IByteStream, data: CraftingSlotAssignData): void {
    NetworkIdCodec.encode(stream, data.ingredientId);
    stream.writeI32(data.slotIndex);
    stream.writeI32(data.optionIndex);
    stream.writeU8(data.sequenceId);
  },
  decode(iter: IReadIterator): CraftingSlotAssignData {
    const ingredientId = NetworkIdCodec.decode(iter);
    const slotIndex = iter.readI32();
    const optionIndex = iter.readI32();
    const sequenceId = iter.readU8();
    return { ingredientId, slotIndex, optionIndex, sequenceId };
  },
});
