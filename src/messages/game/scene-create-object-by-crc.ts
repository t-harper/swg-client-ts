/**
 * SceneCreateObjectByCrc — server-to-client. "Spawn a permanent object at
 * this NetworkId with the template identified by this CRC." Sent in
 * baseline floods during zone-in.
 *
 * Wire layout (addVariable order):
 *   [NetworkId (u64)] m_networkId
 *   [Transform]       m_transform     (Quaternion[xyzw] + Vector[xyz] = 28 bytes)
 *   [u32]             m_templateCrc
 *   [bool]            m_hyperspace
 *
 * Source:
 *   /home/tharper/code/swg-main/src/engine/shared/library/sharedNetworkMessages/src/shared/clientGameServer/SceneChannelMessages.{h,cpp}
 */

import type { IByteStream, IReadIterator } from '../../archive/interface.js';
import { NetworkIdCodec } from '../../archive/network-id.js';
import { type Transform, TransformCodec } from '../../archive/transform.js';
import type { NetworkId } from '../../types.js';
import { GameNetworkMessage, asDecoder, defineMessageMeta } from '../base.js';
import { registerMessage } from '../registry.js';

const META = defineMessageMeta('SceneCreateObjectByCrc');

export class SceneCreateObjectByCrc extends GameNetworkMessage {
  static override readonly messageName = META.messageName;
  static readonly typeCrc = META.typeCrc;
  /** cmd + networkId + transform + templateCrc + hyperspace */
  static override readonly varCount = 5;

  constructor(
    public readonly networkId: NetworkId,
    public readonly transform: Transform,
    public readonly templateCrc: number,
    public readonly hyperspace: boolean = false,
  ) {
    super();
  }

  encodePayload(stream: IByteStream): void {
    NetworkIdCodec.encode(stream, this.networkId);
    TransformCodec.encode(stream, this.transform);
    stream.writeU32(this.templateCrc);
    stream.writeBool(this.hyperspace);
  }

  static decodePayload(iter: IReadIterator): SceneCreateObjectByCrc {
    const networkId = NetworkIdCodec.decode(iter);
    const transform = TransformCodec.decode(iter);
    const templateCrc = iter.readU32();
    const hyperspace = iter.readBool();
    return new SceneCreateObjectByCrc(networkId, transform, templateCrc, hyperspace);
  }
}

export const SceneCreateObjectByCrcDecoder = registerMessage(asDecoder(SceneCreateObjectByCrc));
