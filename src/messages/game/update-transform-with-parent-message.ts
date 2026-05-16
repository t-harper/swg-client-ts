/**
 * UpdateTransformWithParentMessage — bidirectional. The cell-relative twin of
 * `UpdateTransformMessage`. Used for high-frequency position updates while an
 * object is parented to a cell (i.e. inside a building). Position fields are
 * in the cell's local coordinate frame; speed/yaw/seq semantics are identical
 * to the world-coord variant.
 *
 * Wire layout (addVariable order — from `UpdateTransformWithParentMessage.cpp`
 * lines 78-87; note that `cellId` comes BEFORE `networkId`):
 *   [NetworkId (u64)] m_cellId         (the parent cell object)
 *   [NetworkId (u64)] m_networkId      (the moving object)
 *   [i16]             m_positionX      (* 8, signed fixed-point — 0.125m
 *                                       resolution, half the cell-extent of
 *                                       the world variant's * 4)
 *   [i16]             m_positionY      (* 8)
 *   [i16]             m_positionZ      (* 8)
 *   [i32]             m_sequenceNumber
 *   [i8]              m_speed
 *   [i8]              m_yaw            (* 16)
 *   [i8]              m_lookAtYaw      (* 16)
 *   [i8]              m_useLookAtYaw   (bool packed into i8)
 *
 * That's a fixed 30-byte payload (8 + 8 + 2*3 + 4 + 4*1).
 *
 * **Quantization gotcha**: cell-relative uses `* 8` per
 * `UpdateTransformWithParentMessage.cpp:91-93` while the world variant uses
 * `* 4`. Cells are bounded interiors so tighter precision (0.125m vs 0.25m)
 * fits in the same i16 range without overflow risk.
 *
 * Source:
 *   /home/tharper/code/swg-main/src/engine/shared/library/sharedNetworkMessages/src/shared/clientGameServer/UpdateTransformWithParentMessage.{h,cpp}
 */

import type { IByteStream, IReadIterator } from '../../archive/interface.js';
import { NetworkIdCodec } from '../../archive/network-id.js';
import type { NetworkId } from '../../types.js';
import { GameNetworkMessage, asDecoder, defineMessageMeta } from '../base.js';
import { registerMessage } from '../registry.js';

const META = defineMessageMeta('UpdateTransformWithParentMessage');

export class UpdateTransformWithParentMessage extends GameNetworkMessage {
  static override readonly messageName = META.messageName;
  static readonly typeCrc = META.typeCrc;
  /** cmd + cellId + networkId + positionX/Y/Z + sequenceNumber + speed + yaw + lookAtYaw + useLookAtYaw */
  static override readonly varCount = 11;

  constructor(
    public readonly cellId: NetworkId,
    public readonly networkId: NetworkId,
    public readonly positionX: number,
    public readonly positionY: number,
    public readonly positionZ: number,
    public readonly sequenceNumber: number,
    public readonly speed: number,
    public readonly yaw: number,
    public readonly lookAtYaw: number,
    public readonly useLookAtYaw: number,
  ) {
    super();
  }

  encodePayload(stream: IByteStream): void {
    NetworkIdCodec.encode(stream, this.cellId);
    NetworkIdCodec.encode(stream, this.networkId);
    stream.writeI16(this.positionX);
    stream.writeI16(this.positionY);
    stream.writeI16(this.positionZ);
    stream.writeI32(this.sequenceNumber);
    stream.writeI8(this.speed);
    stream.writeI8(this.yaw);
    stream.writeI8(this.lookAtYaw);
    stream.writeI8(this.useLookAtYaw);
  }

  static decodePayload(iter: IReadIterator): UpdateTransformWithParentMessage {
    const cellId = NetworkIdCodec.decode(iter);
    const networkId = NetworkIdCodec.decode(iter);
    const positionX = iter.readI16();
    const positionY = iter.readI16();
    const positionZ = iter.readI16();
    const sequenceNumber = iter.readI32();
    const speed = iter.readI8();
    const yaw = iter.readI8();
    const lookAtYaw = iter.readI8();
    const useLookAtYaw = iter.readI8();
    // Defensive: drain any trailing bytes in case of a future schema extension.
    if (iter.remaining > 0) iter.readBytes(iter.remaining);
    return new UpdateTransformWithParentMessage(
      cellId,
      networkId,
      positionX,
      positionY,
      positionZ,
      sequenceNumber,
      speed,
      yaw,
      lookAtYaw,
      useLookAtYaw,
    );
  }
}

export const UpdateTransformWithParentMessageDecoder = registerMessage(
  asDecoder(UpdateTransformWithParentMessage),
);
