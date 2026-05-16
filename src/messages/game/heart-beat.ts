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

import type { IByteStream, IReadIterator } from '../../archive/interface.js';
import { GameNetworkMessage, asDecoder, defineMessageMeta } from '../base.js';
import { registerMessage } from '../registry.js';

const META = defineMessageMeta('HeartBeat');

export class HeartBeat extends GameNetworkMessage {
  static override readonly messageName = META.messageName;
  static readonly typeCrc = META.typeCrc;
  /** cmd only (empty body) */
  static override readonly varCount = 1;

  encodePayload(_stream: IByteStream): void {
    // empty body
  }

  static decodePayload(_iter: IReadIterator): HeartBeat {
    return new HeartBeat();
  }
}

export const HeartBeatDecoder = registerMessage(asDecoder(HeartBeat));
