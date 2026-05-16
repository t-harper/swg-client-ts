/**
 * CraftingSlotEmpty / CraftEmptySlot (CM_emptySchematicSlotMessage = 264)
 *  — client-to-server.
 *
 * Sent when the player removes an ingredient from a schematic slot. The
 * removed ingredient is moved back into the supplied `targetContainer`
 * (usually the player's inventory or the crafting tool's hopper). The
 * server responds via `CM_craftingResult` with `requestId =
 * CM_emptySchematicSlotMessage`.
 *
 * Note the field order: `slotIndex` comes FIRST in the pack(), then the
 * NetworkId, then the sequenceId — different from the assign-slot subtype.
 *
 * Wire layout (trailer only):
 *   [i32]                  slotIndex          which slot in the active schematic
 *   [NetworkId (i64 LE)]   targetContainer    where to put the returned ingredient
 *   [u8]                   sequenceId         per-session correlation id
 *
 * Source:
 *   /home/tharper/code/swg-main/src/engine/shared/library/sharedNetworkMessages/src/shared/clientGameServer/MessageQueueCraftEmptySlot.cpp:42-66
 */

import type { IByteStream, IReadIterator } from '../../../archive/interface.js';
import { NetworkIdCodec } from '../../../archive/network-id.js';
import type { NetworkId } from '../../../types.js';
import { ObjControllerSubtypeIds, registerObjControllerSubtype } from './registry.js';

export interface CraftingSlotEmptyData {
  /** Zero-based index of the slot to clear. */
  slotIndex: number;
  /** Container NetworkId that receives the removed ingredient (inventory / tool). */
  targetContainer: NetworkId;
  /** Per-session correlation id; echoed in the server's CM_craftingResult reply. */
  sequenceId: number;
}

export const CraftingSlotEmptyKind = 'CraftingSlotEmpty' as const;

export const CraftingSlotEmptyDecoder = registerObjControllerSubtype<CraftingSlotEmptyData>({
  kind: CraftingSlotEmptyKind,
  subtypeId: ObjControllerSubtypeIds.CM_emptySchematicSlotMessage,
  encode(stream: IByteStream, data: CraftingSlotEmptyData): void {
    stream.writeI32(data.slotIndex);
    NetworkIdCodec.encode(stream, data.targetContainer);
    stream.writeU8(data.sequenceId);
  },
  decode(iter: IReadIterator): CraftingSlotEmptyData {
    const slotIndex = iter.readI32();
    const targetContainer = NetworkIdCodec.decode(iter);
    const sequenceId = iter.readU8();
    return { slotIndex, targetContainer, sequenceId };
  },
});
