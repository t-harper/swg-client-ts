/**
 * UpdateTransformMessage — server-to-client. High-frequency position
 * updates for nearby remote objects. The MVP discards the payload after
 * parsing the header.
 *
 * Wire layout (addVariable order):
 *   [NetworkId (u64)] m_networkId
 *   [i16]             m_positionX     (* 4, signed fixed-point)
 *   [i16]             m_positionY     (* 4)
 *   [i16]             m_positionZ     (* 4)
 *   [i32]             m_sequenceNumber
 *   [i8]              m_speed
 *   [i8]              m_yaw           (* 16)
 *   [i8]              m_lookAtYaw     (* 16)
 *   [i8]              m_useLookAtYaw  (bool packed into i8)
 *
 * That's a fixed 22-byte payload. We parse it for byte-accounting but
 * don't expose the decoded floats — Phase 2 + clients that care can
 * extend.
 *
 * Source:
 *   /home/tharper/code/swg-main/src/engine/shared/library/sharedNetworkMessages/src/shared/clientGameServer/UpdateTransformMessage.{h,cpp}
 */

import type { IByteStream, IReadIterator } from '../../archive/interface.js';
import { NetworkIdCodec } from '../../archive/network-id.js';
import type { NetworkId } from '../../types.js';
import { GameNetworkMessage, asDecoder, defineMessageMeta } from '../base.js';
import { registerMessage } from '../registry.js';

const META = defineMessageMeta('UpdateTransformMessage');

export class UpdateTransformMessage extends GameNetworkMessage {
  static override readonly messageName = META.messageName;
  static readonly typeCrc = META.typeCrc;
  /** cmd + networkId + positionX/Y/Z + sequenceNumber + speed + yaw + lookAtYaw + useLookAtYaw */
  static override readonly varCount = 10;

  constructor(
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

  static decodePayload(iter: IReadIterator): UpdateTransformMessage {
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
    return new UpdateTransformMessage(
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

export const UpdateTransformMessageDecoder = registerMessage(asDecoder(UpdateTransformMessage));
