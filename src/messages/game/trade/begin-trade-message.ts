/**
 * BeginTradeMessage — server → client (also client → server when echoing).
 *
 * Sent after both parties have accepted a `TradeMessageId.AcceptTrade` from
 * the prior `CM_secureTrade` ObjController handshake. Carries the
 * counter-party's NetworkId so the trade window UI knows who it's trading
 * with. Triggers the trade-window state on both clients.
 *
 * Wire layout (single AutoVariable):
 *   [NetworkId (i64)] player
 *
 * Source:
 *   /home/tharper/code/swg-main/src/engine/shared/library/sharedNetworkMessages/src/shared/clientGameServer/SecureTradeMessages.{h,cpp}
 */

import type { IByteStream, IReadIterator } from '../../../archive/interface.js';
import { NetworkIdCodec } from '../../../archive/network-id.js';
import type { NetworkId } from '../../../types.js';
import { GameNetworkMessage, asDecoder, defineMessageMeta } from '../../base.js';
import { registerMessage } from '../../registry.js';

const META = defineMessageMeta('BeginTradeMessage');

export class BeginTradeMessage extends GameNetworkMessage {
  static override readonly messageName = META.messageName;
  static readonly typeCrc = META.typeCrc;
  /** cmd + player */
  static override readonly varCount = 2;

  constructor(public readonly player: NetworkId) {
    super();
  }

  encodePayload(stream: IByteStream): void {
    NetworkIdCodec.encode(stream, this.player);
  }

  static decodePayload(iter: IReadIterator): BeginTradeMessage {
    return new BeginTradeMessage(NetworkIdCodec.decode(iter));
  }
}

export const BeginTradeMessageDecoder = registerMessage(asDecoder(BeginTradeMessage));
