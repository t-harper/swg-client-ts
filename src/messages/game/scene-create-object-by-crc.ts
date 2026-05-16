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

import {
  type Transform,
  readNetworkId,
  readTransform,
  writeNetworkId,
  writeTransform,
} from '../../archive/_stub-byte-stream.js';
import type { NetworkId } from '../../types.js';
import {
  GameNetworkMessage,
  type IByteStream,
  type IReadIterator,
  constcrc,
  registerMessage,
} from '../_stub-base.js';

export class SceneCreateObjectByCrc extends GameNetworkMessage {
  static override readonly messageName = 'SceneCreateObjectByCrc';
  static readonly typeCrc = constcrc(SceneCreateObjectByCrc.messageName);

  constructor(
    public readonly networkId: NetworkId,
    public readonly transform: Transform,
    public readonly templateCrc: number,
    public readonly hyperspace: boolean = false,
  ) {
    super();
  }

  encodePayload(stream: IByteStream): void {
    writeNetworkId(stream, this.networkId);
    writeTransform(stream, this.transform);
    stream.writeU32(this.templateCrc);
    stream.writeBool(this.hyperspace);
  }

  static decodePayload(iter: IReadIterator): SceneCreateObjectByCrc {
    const networkId = readNetworkId(iter);
    const transform = readTransform(iter);
    const templateCrc = iter.readU32();
    const hyperspace = iter.readBool();
    return new SceneCreateObjectByCrc(networkId, transform, templateCrc, hyperspace);
  }
}

registerMessage(SceneCreateObjectByCrc);
