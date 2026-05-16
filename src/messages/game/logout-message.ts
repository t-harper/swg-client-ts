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

import type { IByteStream, IReadIterator } from '../../archive/interface.js';
import { GameNetworkMessage, asDecoder, defineMessageMeta } from '../base.js';
import { registerMessage } from '../registry.js';

const META = defineMessageMeta('LogoutMessage');

export class LogoutMessage extends GameNetworkMessage {
  static override readonly messageName = META.messageName;
  static readonly typeCrc = META.typeCrc;
  /** cmd only (empty body) */
  static override readonly varCount = 1;

  encodePayload(_stream: IByteStream): void {
    // empty body
  }

  static decodePayload(_iter: IReadIterator): LogoutMessage {
    return new LogoutMessage();
  }
}

export const LogoutMessageDecoder = registerMessage(asDecoder(LogoutMessage));
