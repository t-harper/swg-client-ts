/**
 * TeleportAck (CM_teleportAck = 319) — client → server.
 *
 * Acknowledge a server-initiated teleport / zone-in. The server inserts a
 * negative sequenceId into the player's `m_teleportIds` set whenever it
 * teleports (or, importantly, during zone-in via
 * `PlayerCreatureController::resyncMovementUpdates`). Until the client
 * replies with a matching CM_teleportAck, `PlayerCreatureController::handleMove`
 * returns false for every client transform (gated by `isTeleporting()`).
 *
 * The signal arrives as an `ObjControllerMessage(message=CM_netUpdateTransform=113)`
 * for the player's own networkId with a NEGATIVE sequenceNumber. The client
 * extracts that seq and echoes it back here.
 *
 * Wire layout (trailer only):
 *   [i32] sequenceId
 *
 * Source:
 *   /home/tharper/code/swg-main/src/engine/server/library/serverGame/src/shared/controller/PlayerCreatureController.cpp:396
 *     (handleTeleportAck — server-side consumer)
 *   /home/tharper/code/swg-main/src/engine/shared/library/sharedNetworkMessages/src/shared/clientGameServer/MessageQueueTeleportAck.cpp
 */

import type { IByteStream, IReadIterator } from '../../../archive/interface.js';
import { ObjControllerSubtypeIds, registerObjControllerSubtype } from './registry.js';

export interface TeleportAckData {
  sequenceId: number;
}

export const TeleportAckKind = 'TeleportAck' as const;

export const TeleportAckDecoder = registerObjControllerSubtype<TeleportAckData>({
  kind: TeleportAckKind,
  subtypeId: ObjControllerSubtypeIds.CM_teleportAck,
  encode(stream: IByteStream, data: TeleportAckData): void {
    stream.writeI32(data.sequenceId);
  },
  decode(iter: IReadIterator): TeleportAckData {
    const sequenceId = iter.readI32();
    return { sequenceId };
  },
});
