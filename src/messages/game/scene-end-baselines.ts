/**
 * SceneEndBaselines — server-to-client. The server has finished sending
 * baseline state for the player and surrounding objects; the client is now
 * ready to acknowledge zone-in with CmdSceneReady.
 *
 * Wire layout:
 *   [NetworkId (u64)] networkId      (the player's id)
 *
 * Source:
 *   /home/tharper/code/swg-main/src/engine/shared/library/sharedNetworkMessages/src/shared/clientGameServer/SceneChannelMessages.{h,cpp}
 */

import type { IByteStream, IReadIterator } from '../../archive/interface.js';
import { NetworkIdCodec } from '../../archive/network-id.js';
import type { NetworkId } from '../../types.js';
import { GameNetworkMessage, asDecoder, defineMessageMeta } from '../base.js';
import { registerMessage } from '../registry.js';

const META = defineMessageMeta('SceneEndBaselines');

export class SceneEndBaselines extends GameNetworkMessage {
  static override readonly messageName = META.messageName;
  static readonly typeCrc = META.typeCrc;
  /** cmd + networkId */
  static override readonly varCount = 2;

  constructor(public readonly networkId: NetworkId) {
    super();
  }

  encodePayload(stream: IByteStream): void {
    NetworkIdCodec.encode(stream, this.networkId);
  }

  static decodePayload(iter: IReadIterator): SceneEndBaselines {
    return new SceneEndBaselines(NetworkIdCodec.decode(iter));
  }
}

export const SceneEndBaselinesDecoder = registerMessage(asDecoder(SceneEndBaselines));
