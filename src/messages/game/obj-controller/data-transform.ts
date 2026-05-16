/**
 * NetUpdateTransform (CM_netUpdateTransform = 113) — bidirectional.
 *
 * Client → server: "I am moving to here" — sent at the cadence the player's
 * client decides (typical Windows client: ~1 packet/2-3s while walking, with
 * 5–10m position deltas; max accepted server-side is the player's recent
 * speed * frame budget).
 *
 * Server → client: position broadcast for ANY creature in the area, including
 * the player themselves. Negative `sequenceNumber` from the server is the
 * teleport-lockout signal (PlayerCreatureController::resyncMovementUpdates,
 * PlayerCreatureController.cpp:285). The client MUST reply with
 * `CM_teleportAck` carrying the matching seq — without it, every subsequent
 * client→server transform is rejected by handleMove's `isTeleporting()` check
 * (PlayerCreatureController.cpp:863).
 *
 * Wire layout (trailer only — the 20-byte ObjControllerMessage header is
 * peeled off upstream):
 *   [u32]            syncStamp        (monotonic ms-since-client-start)
 *   [i32]            sequenceNumber   (>0 client, <0 server teleport signal)
 *   [Quaternion]     rotation         (4 × f32)
 *   [Vector3]        position         (3 × f32, world coords)
 *   [f32]            speed            (real client always sends 0 — server
 *                                      derives effective speed from
 *                                      `distance / (syncStamp delta)`)
 *   [f32]            lookAtYaw
 *   [u8]             useLookAtYaw     (0 or 1)
 *
 * Source:
 *   /home/tharper/code/swg-main/src/engine/shared/library/sharedNetworkMessages/src/shared/clientGameServer/MessageQueueDataTransform.cpp
 */

import type { IByteStream, IReadIterator } from '../../../archive/interface.js';
import { QuaternionCodec, Vector3Codec } from '../../../archive/transform.js';
import type { Quaternion } from '../../../archive/transform.js';
import type { Vector3 } from '../../../types.js';
import { ObjControllerSubtypeIds, registerObjControllerSubtype } from './registry.js';

export interface NetUpdateTransformData {
  syncStamp: number;
  sequenceNumber: number;
  rotation: Quaternion;
  position: Vector3;
  speed: number;
  lookAtYaw: number;
  useLookAtYaw: boolean;
}

export const NetUpdateTransformKind = 'NetUpdateTransform' as const;

export const NetUpdateTransformDecoder = registerObjControllerSubtype<NetUpdateTransformData>({
  kind: NetUpdateTransformKind,
  subtypeId: ObjControllerSubtypeIds.CM_netUpdateTransform,
  encode(stream: IByteStream, data: NetUpdateTransformData): void {
    stream.writeU32(data.syncStamp >>> 0);
    stream.writeI32(data.sequenceNumber);
    QuaternionCodec.encode(stream, data.rotation);
    Vector3Codec.encode(stream, data.position);
    stream.writeF32(data.speed);
    stream.writeF32(data.lookAtYaw);
    stream.writeU8(data.useLookAtYaw ? 1 : 0);
  },
  decode(iter: IReadIterator): NetUpdateTransformData {
    const syncStamp = iter.readU32();
    const sequenceNumber = iter.readI32();
    const rotation = QuaternionCodec.decode(iter);
    const position = Vector3Codec.decode(iter);
    const speed = iter.readF32();
    const lookAtYaw = iter.readF32();
    const useLookAtYaw = iter.readU8() !== 0;
    return { syncStamp, sequenceNumber, rotation, position, speed, lookAtYaw, useLookAtYaw };
  },
});
