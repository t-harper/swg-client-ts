/**
 * LogoutMessage — client-to-server; empty body. Tells the GameServer the
 * player wishes to log out cleanly. The server saves character state,
 * despawns from world, and marks offline. No confirmation is sent back;
 * the client should sleep briefly then send `cUdpPacketTerminate`.
 *
 * Wire layout: empty.
 *
 * Source:
 *   /home/tharper/code/swg-main/src/engine/shared/library/sharedNetworkMessages/src/shared/clientGameServer/LogoutMessage.{h,cpp}
 */

import {
  GameNetworkMessage,
  type IByteStream,
  type IReadIterator,
  constcrc,
  registerMessage,
} from '../_stub-base.js';

export class LogoutMessage extends GameNetworkMessage {
  static override readonly messageName = 'LogoutMessage';
  static readonly typeCrc = constcrc(LogoutMessage.messageName);

  encodePayload(_stream: IByteStream): void {
    // empty body
  }

  static decodePayload(_iter: IReadIterator): LogoutMessage {
    return new LogoutMessage();
  }
}

registerMessage(LogoutMessage);
