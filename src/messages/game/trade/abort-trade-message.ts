/**
 * AbortTradeMessage — bidirectional, empty body.
 *
 * Either party may abort the trade at any point in the handshake. The
 * server, on receiving an abort, broadcasts it to the OTHER party (so
 * their UI also tears down) and discards all in-flight state. Items and
 * credits are NOT moved.
 *
 * Wire layout: empty.
 *
 * Source:
 *   /home/tharper/code/swg-main/src/engine/shared/library/sharedNetworkMessages/src/shared/clientGameServer/SecureTradeMessages.{h,cpp}
 */

import type { IByteStream, IReadIterator } from '../../../archive/interface.js';
import { GameNetworkMessage, asDecoder, defineMessageMeta } from '../../base.js';
import { registerMessage } from '../../registry.js';

const META = defineMessageMeta('AbortTradeMessage');

export class AbortTradeMessage extends GameNetworkMessage {
  static override readonly messageName = META.messageName;
  static readonly typeCrc = META.typeCrc;
  /** cmd only (empty body) */
  static override readonly varCount = 1;

  encodePayload(_stream: IByteStream): void {
    // empty body
  }

  static decodePayload(_iter: IReadIterator): AbortTradeMessage {
    return new AbortTradeMessage();
  }
}

export const AbortTradeMessageDecoder = registerMessage(asDecoder(AbortTradeMessage));
