/**
 * NetUpdateTransformWithParent (CM_netUpdateTransformWithParent = 241) —
 * bidirectional. Cell-relative variant of CM_netUpdateTransform. Used when
 * the player (or any creature) is parented to a cell (inside a building).
 *
 * Wire layout (trailer only):
 *   [NetworkId]      parentCell       (u64)
 *   [u32]            syncStamp
 *   [i32]            sequenceNumber
 *   [Quaternion]     rotation         (4 × f32; cell-local frame)
 *   [Vector3]        position         (3 × f32; cell-local frame, meters)
 *   [f32]            speed
 *   [f32]            lookAtYaw
 *   [u8]             useLookAtYaw
 *
 * Source:
 *   /home/tharper/code/swg-main/src/engine/shared/library/sharedNetworkMessages/src/shared/clientGameServer/MessageQueueDataTransformWithParent.cpp
 */

import type { IByteStream, IReadIterator } from '../../../archive/interface.js';
import { NetworkIdCodec } from '../../../archive/network-id.js';
import { QuaternionCodec, Vector3Codec } from '../../../archive/transform.js';
import type { Quaternion } from '../../../archive/transform.js';
import type { NetworkId, Vector3 } from '../../../types.js';
import { ObjControllerSubtypeIds, registerObjControllerSubtype } from './registry.js';

export interface NetUpdateTransformWithParentData {
  parentCell: NetworkId;
  syncStamp: number;
  sequenceNumber: number;
  rotation: Quaternion;
  position: Vector3;
  speed: number;
  lookAtYaw: number;
  useLookAtYaw: boolean;
}

export const NetUpdateTransformWithParentKind = 'NetUpdateTransformWithParent' as const;

export const NetUpdateTransformWithParentDecoder =
  registerObjControllerSubtype<NetUpdateTransformWithParentData>({
    kind: NetUpdateTransformWithParentKind,
    subtypeId: ObjControllerSubtypeIds.CM_netUpdateTransformWithParent,
    encode(stream: IByteStream, data: NetUpdateTransformWithParentData): void {
      NetworkIdCodec.encode(stream, data.parentCell);
      stream.writeU32(data.syncStamp >>> 0);
      stream.writeI32(data.sequenceNumber);
      QuaternionCodec.encode(stream, data.rotation);
      Vector3Codec.encode(stream, data.position);
      stream.writeF32(data.speed);
      stream.writeF32(data.lookAtYaw);
      stream.writeU8(data.useLookAtYaw ? 1 : 0);
    },
    decode(iter: IReadIterator): NetUpdateTransformWithParentData {
      const parentCell = NetworkIdCodec.decode(iter);
      const syncStamp = iter.readU32();
      const sequenceNumber = iter.readI32();
      const rotation = QuaternionCodec.decode(iter);
      const position = Vector3Codec.decode(iter);
      const speed = iter.readF32();
      const lookAtYaw = iter.readF32();
      const useLookAtYaw = iter.readU8() !== 0;
      return {
        parentCell,
        syncStamp,
        sequenceNumber,
        rotation,
        position,
        speed,
        lookAtYaw,
        useLookAtYaw,
      };
    },
  });
