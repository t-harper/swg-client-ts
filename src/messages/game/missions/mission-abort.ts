/**
 * MissionAbort (CM_missionAbort = 322) — bidirectional.
 *
 * The player-initiated "give up this mission early" path. Unlike `RemoveMission`
 * (which the player triggers from a terminal), `MissionAbort` is the entry
 * the in-flight mission UI uses — the "Abort Mission" button on a mission
 * waypoint context menu, etc.
 *
 * The wire format is the shared `MessageQueueNetworkId` archive — a bare
 * NetworkId, no sequence id and no success bit. The server echoes the same
 * id back as confirmation (see PlayerCreatureController.cpp:994-1004 — the
 * server calls `MissionObject::abortMission()` and re-sends a
 * `MessageQueueNetworkId(missionId)` with `message=CM_missionAbort` back to
 * the auth client).
 *
 * Wire layout (trailer only — the 20-byte ObjControllerMessage header is
 * peeled off upstream):
 *   [NetworkId (i64)] missionObjectId
 *
 * Source:
 *   /home/tharper/code/swg-main/src/engine/shared/library/sharedNetworkMessages/src/shared/clientGameServer/MessageQueueNetworkId.{h,cpp}
 *   Server-side: serverGame/src/shared/controller/PlayerCreatureController.cpp:994-1004
 *   GameControllerMessage.def line 413 (CM_missionAbort = 322)
 */

import type { IByteStream, IReadIterator } from '../../../archive/interface.js';
import { NetworkIdCodec } from '../../../archive/network-id.js';
import type { NetworkId } from '../../../types.js';
import {
  ObjControllerSubtypeIds,
  registerObjControllerSubtype,
} from '../obj-controller/registry.js';

export interface MissionAbortData {
  /** NetworkId of the MissionObject being aborted (echoed by the server in the response). */
  missionObjectId: NetworkId;
}

export const MissionAbortKind = 'MissionAbort' as const;

export const MissionAbortDecoder = registerObjControllerSubtype<MissionAbortData>({
  kind: MissionAbortKind,
  subtypeId: ObjControllerSubtypeIds.CM_missionAbort,
  encode(stream: IByteStream, data: MissionAbortData): void {
    NetworkIdCodec.encode(stream, data.missionObjectId);
  },
  decode(iter: IReadIterator): MissionAbortData {
    const missionObjectId = NetworkIdCodec.decode(iter);
    return { missionObjectId };
  },
});
