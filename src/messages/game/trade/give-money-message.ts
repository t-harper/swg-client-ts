/**
 * GiveMoneyMessage — bidirectional.
 *
 * Sets the credits the sender is offering on their side of the trade
 * window. Either party may update this multiple times; the latest value
 * "wins". The server validates that the offering player has at least this
 * many credits on hand when `VerifyTradeMessage` arrives.
 *
 * Wire layout (single AutoVariable):
 *   [i32] amount
 *
 * Source:
 *   /home/tharper/code/swg-main/src/engine/shared/library/sharedNetworkMessages/src/shared/clientGameServer/SecureTradeMessages.{h,cpp}
 */

import type { IByteStream, IReadIterator } from '../../../archive/interface.js';
import { GameNetworkMessage, asDecoder, defineMessageMeta } from '../../base.js';
import { registerMessage } from '../../registry.js';

const META = defineMessageMeta('GiveMoneyMessage');

export class GiveMoneyMessage extends GameNetworkMessage {
  static override readonly messageName = META.messageName;
  static readonly typeCrc = META.typeCrc;
  /** cmd + amount */
  static override readonly varCount = 2;

  constructor(public readonly amount: number) {
    super();
  }

  encodePayload(stream: IByteStream): void {
    stream.writeI32(this.amount);
  }

  static decodePayload(iter: IReadIterator): GiveMoneyMessage {
    return new GiveMoneyMessage(iter.readI32());
  }
}

export const GiveMoneyMessageDecoder = registerMessage(asDecoder(GiveMoneyMessage));
