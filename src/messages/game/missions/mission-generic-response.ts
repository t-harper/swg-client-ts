/**
 * MissionGenericResponse — server → client.
 *
 * The same MessageQueue payload class is registered under THREE
 * controller-message ids (see `MessageQueueMissionGenericResponse::install`
 * at MessageQueueMissionGenericResponse.cpp:21-28):
 *   - `CM_missionAcceptResponse = 250` — ack for `CM_missionAcceptRequest`
 *   - `CM_missionRemoveResponse = 252` — ack for `CM_missionRemoveRequest`
 *   - `CM_missionCreateResponse = 256` — ack for a server-side create
 *
 * All three carry the same wire shape: the MissionObject NetworkId the
 * server acted on, a success bool, and the sequenceId from the originating
 * request so the client can correlate request → reply.
 *
 * Wire layout (trailer only — the 20-byte ObjControllerMessage header is
 * peeled off upstream; field order from `MessageQueueMissionGenericResponseArchive.cpp::put`
 * lines 33-35):
 *   [NetworkId (i64)] missionObjectId   (the MissionObject the server acted on)
 *   [bool (u8)]       success           (true = action succeeded, false = denied/failed)
 *   [u8]              sequenceId        (echoed from the originating request)
 *
 * Source:
 *   /home/tharper/code/swg-main/src/engine/shared/library/sharedNetworkMessages/src/shared/clientGameServer/MessageQueueMissionGenericResponse.{h,cpp}
 *   /home/tharper/code/swg-main/src/engine/shared/library/sharedNetworkMessages/src/shared/clientGameServer/MessageQueueMissionGenericResponseArchive.cpp:31-37
 *   Server emits the accept-response at: serverGame/src/shared/controller/PlayerCreatureController.cpp:1053
 */

import type { IByteStream, IReadIterator } from '../../../archive/interface.js';
import { NetworkIdCodec } from '../../../archive/network-id.js';
import type { NetworkId } from '../../../types.js';
import {
  type ObjControllerSubtypeDecoder,
  ObjControllerSubtypeIds,
  registerObjControllerSubtype,
} from '../obj-controller/registry.js';

export interface MissionGenericResponseData {
  /** NetworkId of the MissionObject the server acted on. */
  missionObjectId: NetworkId;
  /** True = action succeeded; false = server denied or could not perform it. */
  success: boolean;
  /** Per-player sequence id echoed from the originating request. */
  sequenceId: number;
}

const codec = {
  encode(stream: IByteStream, data: MissionGenericResponseData): void {
    NetworkIdCodec.encode(stream, data.missionObjectId);
    stream.writeBool(data.success);
    stream.writeU8(data.sequenceId);
  },
  decode(iter: IReadIterator): MissionGenericResponseData {
    const missionObjectId = NetworkIdCodec.decode(iter);
    const success = iter.readBool();
    const sequenceId = iter.readU8();
    return { missionObjectId, success, sequenceId };
  },
};

export const MissionAcceptResponseKind = 'MissionAcceptResponse' as const;
export const MissionRemoveResponseKind = 'MissionRemoveResponse' as const;
export const MissionCreateResponseKind = 'MissionCreateResponse' as const;

/** Server → client. Ack for `CM_missionAcceptRequest`. */
export const MissionAcceptResponseDecoder: ObjControllerSubtypeDecoder<MissionGenericResponseData> =
  registerObjControllerSubtype<MissionGenericResponseData>({
    kind: MissionAcceptResponseKind,
    subtypeId: ObjControllerSubtypeIds.CM_missionAcceptResponse,
    encode: codec.encode,
    decode: codec.decode,
  });

/** Server → client. Ack for `CM_missionRemoveRequest` (mission abandoned). */
export const MissionRemoveResponseDecoder: ObjControllerSubtypeDecoder<MissionGenericResponseData> =
  registerObjControllerSubtype<MissionGenericResponseData>({
    kind: MissionRemoveResponseKind,
    subtypeId: ObjControllerSubtypeIds.CM_missionRemoveResponse,
    encode: codec.encode,
    decode: codec.decode,
  });

/** Server → client. Ack for a server-side mission create. */
export const MissionCreateResponseDecoder: ObjControllerSubtypeDecoder<MissionGenericResponseData> =
  registerObjControllerSubtype<MissionGenericResponseData>({
    kind: MissionCreateResponseKind,
    subtypeId: ObjControllerSubtypeIds.CM_missionCreateResponse,
    encode: codec.encode,
    decode: codec.decode,
  });
