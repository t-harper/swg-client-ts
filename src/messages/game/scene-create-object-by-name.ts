/**
 * SceneCreateObjectByName — server-to-client. Same as SceneCreateObjectByCrc
 * but the template is given by full path string instead of CRC.
 *
 * Wire layout (addVariable order):
 *   [NetworkId (u64)] m_networkId
 *   [Transform]       m_transform     (Quaternion[xyzw] + Vector[xyz] = 28 bytes)
 *   [string]          m_templateName
 *   [bool]            m_hyperspace
 *
 * Source:
 *   /home/tharper/code/swg-main/src/engine/shared/library/sharedNetworkMessages/src/shared/clientGameServer/SceneChannelMessages.{h,cpp}
 */

import {
  type Transform,
  readNetworkId,
  readString,
  readTransform,
  writeNetworkId,
  writeString,
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

export class SceneCreateObjectByName extends GameNetworkMessage {
  static override readonly messageName = 'SceneCreateObjectByName';
  static readonly typeCrc = constcrc(SceneCreateObjectByName.messageName);

  constructor(
    public readonly networkId: NetworkId,
    public readonly transform: Transform,
    public readonly templateName: string,
    public readonly hyperspace: boolean = false,
  ) {
    super();
  }

  encodePayload(stream: IByteStream): void {
    writeNetworkId(stream, this.networkId);
    writeTransform(stream, this.transform);
    writeString(stream, this.templateName);
    stream.writeBool(this.hyperspace);
  }

  static decodePayload(iter: IReadIterator): SceneCreateObjectByName {
    const networkId = readNetworkId(iter);
    const transform = readTransform(iter);
    const templateName = readString(iter);
    const hyperspace = iter.readBool();
    return new SceneCreateObjectByName(networkId, transform, templateName, hyperspace);
  }
}

registerMessage(SceneCreateObjectByName);
