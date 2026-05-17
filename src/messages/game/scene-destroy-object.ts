/**
 * SceneDestroyObject — server-to-client. "Forget this object." Sent when an
 * object leaves the client's view range, is destroyed server-side, or
 * enters/exits hyperspace.
 *
 * The `hyperspace` flag distinguishes a "real" destroy (object is gone)
 * from a hyperspace-leave (object is travelling to another scene). The
 * Windows client uses this to choose a fade-out animation vs a hyperspace
 * vortex effect. For the headless client both cases collapse to "remove
 * from world model."
 *
 * Wire layout (addVariable order):
 *   [NetworkId (u64)] m_networkId
 *   [bool]            m_hyperspace
 *
 * Source:
 *   /home/tharper/code/swg-main/src/engine/shared/library/sharedNetworkMessages/src/shared/clientGameServer/SceneChannelMessages.{h,cpp}
 */

import type { IByteStream, IReadIterator } from '../../archive/interface.js';
import { NetworkIdCodec } from '../../archive/network-id.js';
import type { NetworkId } from '../../types.js';
import { GameNetworkMessage, asDecoder, defineMessageMeta } from '../base.js';
import { registerMessage } from '../registry.js';

const META = defineMessageMeta('SceneDestroyObject');

export class SceneDestroyObject extends GameNetworkMessage {
  static override readonly messageName = META.messageName;
  static readonly typeCrc = META.typeCrc;
  /** cmd + networkId + hyperspace */
  static override readonly varCount = 3;

  constructor(
    public readonly networkId: NetworkId,
    public readonly hyperspace: boolean = false,
  ) {
    super();
  }

  encodePayload(stream: IByteStream): void {
    NetworkIdCodec.encode(stream, this.networkId);
    stream.writeBool(this.hyperspace);
  }

  static decodePayload(iter: IReadIterator): SceneDestroyObject {
    const networkId = NetworkIdCodec.decode(iter);
    const hyperspace = iter.readBool();
    return new SceneDestroyObject(networkId, hyperspace);
  }
}

export const SceneDestroyObjectDecoder = registerMessage(asDecoder(SceneDestroyObject));
