/**
 * VerifyTradeMessage — bidirectional, empty body.
 *
 * The final "yes really, commit" confirmation. Sent by the server to both
 * clients after both parties accepted; each client echoes it back to
 * confirm. When BOTH echoes arrive the server actually moves items and
 * credits, then broadcasts `TradeCompleteMessage` to both sides.
 *
 * Wire layout: empty.
 *
 * Source:
 *   /home/tharper/code/swg-main/src/engine/shared/library/sharedNetworkMessages/src/shared/clientGameServer/SecureTradeMessages.{h,cpp}
 */

import type { IByteStream, IReadIterator } from '../../../archive/interface.js';
import { GameNetworkMessage, asDecoder, defineMessageMeta } from '../../base.js';
import { registerMessage } from '../../registry.js';

const META = defineMessageMeta('VerifyTradeMessage');

export class VerifyTradeMessage extends GameNetworkMessage {
  static override readonly messageName = META.messageName;
  static readonly typeCrc = META.typeCrc;
  /** cmd only (empty body) */
  static override readonly varCount = 1;

  encodePayload(_stream: IByteStream): void {
    // empty body
  }

  static decodePayload(_iter: IReadIterator): VerifyTradeMessage {
    return new VerifyTradeMessage();
  }
}

export const VerifyTradeMessageDecoder = registerMessage(asDecoder(VerifyTradeMessage));
