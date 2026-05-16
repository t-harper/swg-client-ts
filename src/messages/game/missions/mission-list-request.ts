/**
 * MissionListRequest (CM_missionListRequest = 245) — client → server.
 *
 * Sent when the player walks up to a mission terminal and opens the mission
 * board. The server replies with a `MissionListResponse` (CM=246) and a
 * subsequent `PopulateMissionBrowserMessage` carrying the NetworkIds of the
 * MissionObjects the terminal generated. (We don't model the response
 * subtype here — the visible state is delivered as MissionObject SHARED
 * baselines populated into the player's invisible "mission bag" inventory
 * by the server. See `src/messages/game/baselines/mission-object-baseline-3.ts`.)
 *
 * Wire layout (trailer only — the 20-byte ObjControllerMessage header is
 * peeled off upstream; field order from `MessageQueueMissionListRequest.cpp::pack`
 * lines 45-47):
 *   [u8]              flags         (Flags::F_mineOnly = 0x01; usually 0)
 *   [u8]              sequenceId    (per-terminal monotonic; echoed in the response)
 *   [NetworkId (i64)] terminalId    (the mission terminal the player is interacting with)
 *
 * Source:
 *   /home/tharper/code/swg-main/src/engine/shared/library/sharedNetworkMessages/src/shared/clientGameServer/MessageQueueMissionListRequest.{h,cpp}
 *   Server-side dispatch: serverGame/src/shared/controller/PlayerCreatureController.cpp:1006-1032
 */

import type { IByteStream, IReadIterator } from '../../../archive/interface.js';
import { NetworkIdCodec } from '../../../archive/network-id.js';
import type { NetworkId } from '../../../types.js';
import {
  ObjControllerSubtypeIds,
  registerObjControllerSubtype,
} from '../obj-controller/registry.js';

/** Bit flags for `MissionListRequest.flags`. Source: MessageQueueMissionListRequest.h:23-26. */
export const MissionListRequestFlags = {
  /** Only return missions previously claimed by this player. Default behavior leaves this clear. */
  MineOnly: 0x01,
} as const;

export interface MissionListRequestData {
  /** Bit flags from `MissionListRequestFlags`. Usually 0. */
  flags: number;
  /** Per-terminal monotonic id; echoed in the response so the client can correlate. */
  sequenceId: number;
  /** The NetworkId of the mission terminal the player is querying. */
  terminalId: NetworkId;
}

export const MissionListRequestKind = 'MissionListRequest' as const;

export const MissionListRequestDecoder = registerObjControllerSubtype<MissionListRequestData>({
  kind: MissionListRequestKind,
  subtypeId: ObjControllerSubtypeIds.CM_missionListRequest,
  encode(stream: IByteStream, data: MissionListRequestData): void {
    stream.writeU8(data.flags);
    stream.writeU8(data.sequenceId);
    NetworkIdCodec.encode(stream, data.terminalId);
  },
  decode(iter: IReadIterator): MissionListRequestData {
    const flags = iter.readU8();
    const sequenceId = iter.readU8();
    const terminalId = NetworkIdCodec.decode(iter);
    return { flags, sequenceId, terminalId };
  },
});
