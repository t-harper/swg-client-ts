/**
 * BidAuctionMessage — client-to-server. Bid on a live auction. `bid` is the
 * actual credits to commit; `maxProxyBid` is the optional auto-rebid ceiling
 * the server uses to outbid competitors automatically up to that amount.
 *
 * Wire layout (addVariable order from BidAuctionMessage.cpp:20-22):
 *   [NetworkId] itemId
 *   [i32]       bid
 *   [i32]       maxProxyBid
 *
 * Source:
 *   /home/tharper/code/swg-main/src/engine/shared/library/sharedNetworkMessages/src/shared/clientGameServer/BidAuctionMessage.{h,cpp}
 */

import type { IByteStream, IReadIterator } from '../../../archive/interface.js';
import { NetworkIdCodec } from '../../../archive/network-id.js';
import type { NetworkId } from '../../../types.js';
import { GameNetworkMessage, asDecoder, defineMessageMeta } from '../../base.js';
import { registerMessage } from '../../registry.js';

const META = defineMessageMeta('BidAuctionMessage');

export class BidAuctionMessage extends GameNetworkMessage {
  static override readonly messageName = META.messageName;
  static readonly typeCrc = META.typeCrc;
  /** cmd + itemId + bid + maxProxyBid */
  static override readonly varCount = 4;

  constructor(
    public readonly itemId: NetworkId,
    public readonly bid: number,
    public readonly maxProxyBid: number,
  ) {
    super();
  }

  encodePayload(stream: IByteStream): void {
    NetworkIdCodec.encode(stream, this.itemId);
    stream.writeI32(this.bid);
    stream.writeI32(this.maxProxyBid);
  }

  static decodePayload(iter: IReadIterator): BidAuctionMessage {
    const itemId = NetworkIdCodec.decode(iter);
    const bid = iter.readI32();
    const maxProxyBid = iter.readI32();
    return new BidAuctionMessage(itemId, bid, maxProxyBid);
  }
}

export const BidAuctionMessageDecoder = registerMessage(asDecoder(BidAuctionMessage));
