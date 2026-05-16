/**
 * CraftingResult / GenericIntResponse (CM_craftingResult = 268) — server-to-client.
 *
 * The generic server reply for any client-initiated crafting command. Carries
 * the request id (which CM_* subtype this is responding to — e.g.
 * `CM_requestCraftingSession`, `CM_createPrototype`, `CM_createManfSchematic`,
 * `CM_restartCraftingSession`), the success/failure verdict as an int, and
 * the per-session sequence id the client supplied so it can correlate the
 * reply with its outstanding request.
 *
 * The same handler is registered for **three** controller-message ids:
 *   - `CM_craftingResult`         (268)
 *   - `CM_nextCraftingStageResult`(446)
 *   - `CM_experimentResult`       (275)
 *
 * We register the decoder under `CM_craftingResult` (the canonical id used
 * by `commandFuncRequestCraftingSession`, `commandFuncCreatePrototype`,
 * `commandFuncCreateManfSchematic`, `commandFuncRestartCraftingSession`).
 * The other two ids share the same wire layout — consumers can re-use this
 * decoder by hand for those, but we don't auto-register the same decoder
 * under multiple ids (the registry rejects collisions).
 *
 * Wire layout (trailer only):
 *   [i32]    requestId           CM_* subtype the reply is for
 *   [i32]    response            success/failure or any int payload
 *   [u8]     sequenceId          echoes the client's request sequenceId
 *
 * Source:
 *   /home/tharper/code/swg-main/src/engine/shared/library/sharedNetworkMessages/src/shared/clientGameServer/MessageQueueGenericIntResponse.cpp:18-27
 *   /home/tharper/code/swg-main/src/engine/shared/library/sharedNetworkMessages/src/shared/clientGameServer/MessageQueueGenericIntResponseArchive.cpp:16-40
 */

import type { IByteStream, IReadIterator } from '../../../archive/interface.js';
import { ObjControllerSubtypeIds, registerObjControllerSubtype } from './registry.js';

export interface CraftingResultData {
  /** Which CM_* the server is replying to (e.g. CM_requestCraftingSession = 271). */
  requestId: number;
  /** Verdict — typically 0/1 for failure/success, or a CraftingResult enum value. */
  response: number;
  /** Echoes the client's request sequenceId so the client can correlate. */
  sequenceId: number;
}

export const CraftingResultKind = 'CraftingResult' as const;

export const CraftingResultDecoder = registerObjControllerSubtype<CraftingResultData>({
  kind: CraftingResultKind,
  subtypeId: ObjControllerSubtypeIds.CM_craftingResult,
  encode(stream: IByteStream, data: CraftingResultData): void {
    stream.writeI32(data.requestId);
    stream.writeI32(data.response);
    stream.writeU8(data.sequenceId);
  },
  decode(iter: IReadIterator): CraftingResultData {
    const requestId = iter.readI32();
    const response = iter.readI32();
    const sequenceId = iter.readU8();
    return { requestId, response, sequenceId };
  },
});
