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

import type { NetworkId } from '../../types.js';
import {
  GameNetworkMessage,
  constcrc,
  registerMessage,
  type IByteStream,
  type IReadIterator,
} from '../_stub-base.js';
import { readNetworkId, writeNetworkId } from '../../archive/_stub-byte-stream.js';

export class SceneEndBaselines extends GameNetworkMessage {
  static override readonly messageName = 'SceneEndBaselines';
  static readonly typeCrc = constcrc(SceneEndBaselines.messageName);

  constructor(public readonly networkId: NetworkId) {
    super();
  }

  encodePayload(stream: IByteStream): void {
    writeNetworkId(stream, this.networkId);
  }

  static decodePayload(iter: IReadIterator): SceneEndBaselines {
    return new SceneEndBaselines(readNetworkId(iter));
  }
}

registerMessage(SceneEndBaselines);
