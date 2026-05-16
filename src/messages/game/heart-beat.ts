/**
 * HeartBeat — bidirectional, empty body. Sent periodically to keep the
 * connection alive at the GameNetworkMessage layer (the SOE layer has its
 * own KeepAlive opcode).
 *
 * The ConnectionServer auto-sends HeartBeats to the client roughly every
 * (frameTime * 1000)ms while waiting for client input — see
 * ClientConnection.cpp::onReceive.
 *
 * Wire layout: empty.
 *
 * Source:
 *   /home/tharper/code/swg-main/src/engine/shared/library/sharedNetworkMessages/src/shared/clientGameServer/HeartBeat.{h,cpp}
 */

import {
  GameNetworkMessage,
  type IByteStream,
  type IReadIterator,
  constcrc,
  registerMessage,
} from '../_stub-base.js';

export class HeartBeat extends GameNetworkMessage {
  static override readonly messageName = 'HeartBeat';
  static readonly typeCrc = constcrc(HeartBeat.messageName);

  encodePayload(_stream: IByteStream): void {
    // empty body
  }

  static decodePayload(_iter: IReadIterator): HeartBeat {
    return new HeartBeat();
  }
}

registerMessage(HeartBeat);
