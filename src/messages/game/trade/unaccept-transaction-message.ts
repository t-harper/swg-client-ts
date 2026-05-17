/**
 * UnAcceptTransactionMessage — bidirectional, empty body.
 *
 * The inverse of `AcceptTransactionMessage`. The sender un-checks their
 * "I accept" box (typically because they want to add or remove an item
 * or adjust credits). Cancels any in-flight verify state on both sides.
 *
 * Wire layout: empty.
 *
 * Source:
 *   /home/tharper/code/swg-main/src/engine/shared/library/sharedNetworkMessages/src/shared/clientGameServer/SecureTradeMessages.{h,cpp}
 */

import type { IByteStream, IReadIterator } from '../../../archive/interface.js';
import { GameNetworkMessage, asDecoder, defineMessageMeta } from '../../base.js';
import { registerMessage } from '../../registry.js';

const META = defineMessageMeta('UnAcceptTransactionMessage');

export class UnAcceptTransactionMessage extends GameNetworkMessage {
  static override readonly messageName = META.messageName;
  static readonly typeCrc = META.typeCrc;
  /** cmd only (empty body) */
  static override readonly varCount = 1;

  encodePayload(_stream: IByteStream): void {
    // empty body
  }

  static decodePayload(_iter: IReadIterator): UnAcceptTransactionMessage {
    return new UnAcceptTransactionMessage();
  }
}

export const UnAcceptTransactionMessageDecoder = registerMessage(
  asDecoder(UnAcceptTransactionMessage),
);
