/**
 * MissionGenericRequest — client → server.
 *
 * The same MessageQueue payload class is registered under two
 * controller-message ids:
 *   - `CM_missionAcceptRequest = 249` — "accept this mission"
 *   - `CM_missionRemoveRequest = 251` — "abandon this mission"
 *
 * Both directions carry the same wire shape: the MissionObject NetworkId
 * the player is acting on, the terminal NetworkId the action originated
 * from, and a per-player sequence id the server will echo back in the
 * `MissionGenericResponse`.
 *
 * Wire layout (trailer only — the 20-byte ObjControllerMessage header is
 * peeled off upstream; field order from `MessageQueueMissionGenericRequestArchive.cpp::put`
 * lines 33-35):
 *   [NetworkId (i64)] missionObjectId   (the MissionObject this targets)
 *   [NetworkId (i64)] terminalId        (the mission terminal in scope)
 *   [u8]              sequenceId        (per-player; echoed in the response)
 *
 * Source:
 *   /home/tharper/code/swg-main/src/engine/shared/library/sharedNetworkMessages/src/shared/clientGameServer/MessageQueueMissionGenericRequest.{h,cpp}
 *   /home/tharper/code/swg-main/src/engine/shared/library/sharedNetworkMessages/src/shared/clientGameServer/MessageQueueMissionGenericRequestArchive.cpp:31-37
 *   Server-side dispatch (accept path): serverGame/src/shared/controller/PlayerCreatureController.cpp:1034-1055
 */

import type { IByteStream, IReadIterator } from '../../../archive/interface.js';
import { NetworkIdCodec } from '../../../archive/network-id.js';
import type { NetworkId } from '../../../types.js';
import {
  type ObjControllerSubtypeDecoder,
  ObjControllerSubtypeIds,
  registerObjControllerSubtype,
} from '../obj-controller/registry.js';

export interface MissionGenericRequestData {
  /** NetworkId of the MissionObject this request targets. */
  missionObjectId: NetworkId;
  /** NetworkId of the mission terminal the request originated from. */
  terminalId: NetworkId;
  /** Per-player monotonic id; echoed in the response so the client can correlate. */
  sequenceId: number;
}

const codec = {
  encode(stream: IByteStream, data: MissionGenericRequestData): void {
    NetworkIdCodec.encode(stream, data.missionObjectId);
    NetworkIdCodec.encode(stream, data.terminalId);
    stream.writeU8(data.sequenceId);
  },
  decode(iter: IReadIterator): MissionGenericRequestData {
    const missionObjectId = NetworkIdCodec.decode(iter);
    const terminalId = NetworkIdCodec.decode(iter);
    const sequenceId = iter.readU8();
    return { missionObjectId, terminalId, sequenceId };
  },
};

export const MissionAcceptRequestKind = 'MissionAcceptRequest' as const;
export const MissionRemoveRequestKind = 'MissionRemoveRequest' as const;

/** Client → server. Accept the named mission from the named terminal. */
export const MissionAcceptRequestDecoder: ObjControllerSubtypeDecoder<MissionGenericRequestData> =
  registerObjControllerSubtype<MissionGenericRequestData>({
    kind: MissionAcceptRequestKind,
    subtypeId: ObjControllerSubtypeIds.CM_missionAcceptRequest,
    encode: codec.encode,
    decode: codec.decode,
  });

/** Client → server. Abandon (remove) the named mission. */
export const MissionRemoveRequestDecoder: ObjControllerSubtypeDecoder<MissionGenericRequestData> =
  registerObjControllerSubtype<MissionGenericRequestData>({
    kind: MissionRemoveRequestKind,
    subtypeId: ObjControllerSubtypeIds.CM_missionRemoveRequest,
    encode: codec.encode,
    decode: codec.decode,
  });
