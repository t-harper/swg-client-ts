/**
 * CraftingFinish / CreatePrototype (CM_createPrototype = 266) — client-to-server.
 *
 * Sent at the end of a crafting session to finalize the schematic into an
 * actual in-world prototype item. Server-side this triggers
 * `commandFuncCreatePrototype`, which calls `player->createPrototype(realPrototype)`
 * and replies via `CM_craftingResult` carrying a `MessageQueueGenericIntResponse`.
 *
 * The wire payload is the `MessageQueueGeneric` form shared by the simple
 * crafting commands (cancel / restart / nextStage / createPrototype /
 * createManfSchematic): just a `uint8` sequence id.
 *
 * Note: the `realPrototype` boolean and other params for `createPrototype`
 * arrive on the server through the **command queue** path (the
 * `useAbility('createPrototype', tool, '<seq> <realProto>')` route — see
 * `commandFuncCreatePrototype` in `CommandCppFuncs.cpp`). When the message
 * comes in as a bare `MessageQueueGeneric`, only the `sequenceId` is on the
 * wire; defaults apply server-side.
 *
 * Wire layout (trailer only):
 *   [u8]   sequenceId          per-session correlation id
 *
 * Source:
 *   /home/tharper/code/swg-main/src/engine/shared/library/sharedNetworkMessages/src/shared/clientGameServer/MessageQueueGeneric.cpp:21-57
 */

import type { IByteStream, IReadIterator } from '../../../archive/interface.js';
import { ObjControllerSubtypeIds, registerObjControllerSubtype } from './registry.js';

export interface CraftingFinishData {
  /** Per-session correlation id; echoed in the server's CM_craftingResult reply. */
  sequenceId: number;
}

export const CraftingFinishKind = 'CraftingFinish' as const;

export const CraftingFinishDecoder = registerObjControllerSubtype<CraftingFinishData>({
  kind: CraftingFinishKind,
  subtypeId: ObjControllerSubtypeIds.CM_createPrototype,
  encode(stream: IByteStream, data: CraftingFinishData): void {
    stream.writeU8(data.sequenceId);
  },
  decode(iter: IReadIterator): CraftingFinishData {
    return { sequenceId: iter.readU8() };
  },
});
