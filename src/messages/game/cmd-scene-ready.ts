/**
 * CmdSceneReady — client-to-server; empty body. The client signals it has
 * loaded the scene and is ready to participate. The server marks us as
 * "zoned in" after receiving this.
 *
 * Wire layout: empty.
 *
 * Source:
 *   /home/tharper/code/swg-main/src/engine/shared/library/sharedNetworkMessages/src/shared/clientGameServer/CommandChannelMessages.{h,cpp}
 */

import {
  GameNetworkMessage,
  constcrc,
  registerMessage,
  type IByteStream,
  type IReadIterator,
} from '../_stub-base.js';

export class CmdSceneReady extends GameNetworkMessage {
  static override readonly messageName = 'CmdSceneReady';
  static readonly typeCrc = constcrc(CmdSceneReady.messageName);

  encodePayload(_stream: IByteStream): void {
    // empty body
  }

  static decodePayload(_iter: IReadIterator): CmdSceneReady {
    return new CmdSceneReady();
  }
}

registerMessage(CmdSceneReady);
