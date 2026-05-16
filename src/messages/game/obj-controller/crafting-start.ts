/**
 * CraftingStart / RequestCraftingSession (CM_requestCraftingSession = 271)
 *  — client-to-server.
 *
 * The wire payload behind `requestCraftingSession`. Carries the NetworkId of
 * the crafting tool or station the player is interacting with, plus a
 * monotonic per-client sequence id used to correlate the server's
 * `CM_craftingResult` reply (a `MessageQueueGenericIntResponse` carrying the
 * success/failure verdict).
 *
 * Note: client scripts usually start crafting via the higher-level command
 * queue (`useAbility('requestCraftingSession', toolId)`), which packages
 * everything into a `MessageQueueCommandQueueEnqueue` and the server invokes
 * `commandFuncRequestCraftingSession`. This subtype is the *server-internal*
 * MessageQueue payload; some script paths (and `PlayerObject` callbacks) emit
 * the bare `MessageQueueCraftRequestSession` directly.
 *
 * Wire layout (trailer only — the 20-byte ObjControllerMessage header is
 * peeled off upstream):
 *   [NetworkId (i64 LE)]   stationId           the tool / station NetworkId
 *   [u8]                   sequenceId          per-session correlation id
 *
 * Source:
 *   /home/tharper/code/swg-main/src/engine/shared/library/sharedNetworkMessages/src/shared/clientGameServer/MessageQueueCraftRequestSession.cpp:34-55
 */

import type { IByteStream, IReadIterator } from '../../../archive/interface.js';
import { NetworkIdCodec } from '../../../archive/network-id.js';
import type { NetworkId } from '../../../types.js';
import { ObjControllerSubtypeIds, registerObjControllerSubtype } from './registry.js';

export interface CraftingStartData {
  /** NetworkId of the crafting tool / station the session is being opened against. */
  stationId: NetworkId;
  /** Per-session correlation id; echoed by the server's CM_craftingResult reply. */
  sequenceId: number;
}

export const CraftingStartKind = 'CraftingStart' as const;

export const CraftingStartDecoder = registerObjControllerSubtype<CraftingStartData>({
  kind: CraftingStartKind,
  subtypeId: ObjControllerSubtypeIds.CM_requestCraftingSession,
  encode(stream: IByteStream, data: CraftingStartData): void {
    NetworkIdCodec.encode(stream, data.stationId);
    stream.writeU8(data.sequenceId);
  },
  decode(iter: IReadIterator): CraftingStartData {
    const stationId = NetworkIdCodec.decode(iter);
    const sequenceId = iter.readU8();
    return { stationId, sequenceId };
  },
});
