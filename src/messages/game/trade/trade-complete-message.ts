/**
 * TradeCompleteMessage — server → client, empty body.
 *
 * Broadcast by the server to BOTH parties after both verify echoes arrive
 * and the items + credits have actually been moved. Signals the trade
 * window UI to close cleanly. No payload — the server already broadcast
 * the new container locations via baseline deltas.
 *
 * Wire layout: empty.
 *
 * Source:
 *   /home/tharper/code/swg-main/src/engine/shared/library/sharedNetworkMessages/src/shared/clientGameServer/SecureTradeMessages.{h,cpp}
 */

import type { IByteStream, IReadIterator } from '../../../archive/interface.js';
import { GameNetworkMessage, asDecoder, defineMessageMeta } from '../../base.js';
import { registerMessage } from '../../registry.js';

const META = defineMessageMeta('TradeCompleteMessage');

export class TradeCompleteMessage extends GameNetworkMessage {
  static override readonly messageName = META.messageName;
  static readonly typeCrc = META.typeCrc;
  /** cmd only (empty body) */
  static override readonly varCount = 1;

  encodePayload(_stream: IByteStream): void {
    // empty body
  }

  static decodePayload(_iter: IReadIterator): TradeCompleteMessage {
    return new TradeCompleteMessage();
  }
}

export const TradeCompleteMessageDecoder = registerMessage(asDecoder(TradeCompleteMessage));
