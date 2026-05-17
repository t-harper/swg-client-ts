/**
 * DetachRider (CM_detachRiderForMount = 541) — server → server.
 *
 * Sent from a non-authoritative copy of the mount asking the authoritative
 * copy to detach a specific rider (e.g. when the rider zoned, the mount
 * server-process changed, etc.). The CreatureController on the receiving
 * side calls `owner->detachRider(riderId)`.
 *
 * The trailer is the standard `MessageQueueGenericValueType<NetworkId>` form
 * (an 8-byte little-endian i64) — same archive helper used by many
 * single-NetworkId payloads.
 *
 * Wire layout (trailer only):
 *   [NetworkId (i64 LE)]  riderId
 *
 * Source:
 *   /home/tharper/code/swg-main/src/engine/server/library/serverGame/src/shared/object/CreatureObject_Mounts.cpp:799-801
 *   /home/tharper/code/swg-main/src/engine/server/library/serverGame/src/shared/controller/CreatureController.cpp:831-841
 */

import type { IByteStream, IReadIterator } from '../../../archive/interface.js';
import { NetworkIdCodec } from '../../../archive/network-id.js';
import type { NetworkId } from '../../../types.js';
import { ObjControllerSubtypeIds, registerObjControllerSubtype } from './registry.js';

export interface DetachRiderData {
  riderId: NetworkId;
}

export const DetachRiderKind = 'DetachRider' as const;

export const DetachRiderDecoder = registerObjControllerSubtype<DetachRiderData>({
  kind: DetachRiderKind,
  subtypeId: ObjControllerSubtypeIds.CM_detachRiderForMount,
  encode(stream: IByteStream, data: DetachRiderData): void {
    NetworkIdCodec.encode(stream, data.riderId);
  },
  decode(iter: IReadIterator): DetachRiderData {
    const riderId = NetworkIdCodec.decode(iter);
    return { riderId };
  },
});
