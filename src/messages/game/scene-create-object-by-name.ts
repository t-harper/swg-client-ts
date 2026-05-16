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

import type { IByteStream, IReadIterator } from '../../archive/interface.js';
import { NetworkIdCodec } from '../../archive/network-id.js';
import { readStdString, writeStdString } from '../../archive/string.js';
import { type Transform, TransformCodec } from '../../archive/transform.js';
import type { NetworkId } from '../../types.js';
import { GameNetworkMessage, asDecoder, defineMessageMeta } from '../base.js';
import { registerMessage } from '../registry.js';

const META = defineMessageMeta('SceneCreateObjectByName');

export class SceneCreateObjectByName extends GameNetworkMessage {
  static override readonly messageName = META.messageName;
  static readonly typeCrc = META.typeCrc;
  /** cmd + networkId + transform + templateName + hyperspace */
  static override readonly varCount = 5;

  constructor(
    public readonly networkId: NetworkId,
    public readonly transform: Transform,
    public readonly templateName: string,
    public readonly hyperspace: boolean = false,
  ) {
    super();
  }

  encodePayload(stream: IByteStream): void {
    NetworkIdCodec.encode(stream, this.networkId);
    TransformCodec.encode(stream, this.transform);
    writeStdString(stream, this.templateName);
    stream.writeBool(this.hyperspace);
  }

  static decodePayload(iter: IReadIterator): SceneCreateObjectByName {
    const networkId = NetworkIdCodec.decode(iter);
    const transform = TransformCodec.decode(iter);
    const templateName = readStdString(iter);
    const hyperspace = iter.readBool();
    return new SceneCreateObjectByName(networkId, transform, templateName, hyperspace);
  }
}

export const SceneCreateObjectByNameDecoder = registerMessage(asDecoder(SceneCreateObjectByName));
