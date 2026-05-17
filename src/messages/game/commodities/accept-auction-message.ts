/**
 * AcceptAuctionMessage — client-to-server. Accept (instant-buy) a buy-now
 * priced auction.
 *
 * Wire layout (addVariable order from AcceptAuctionMessage.cpp:18):
 *   [NetworkId] itemId
 *
 * Source:
 *   /home/tharper/code/swg-main/src/engine/shared/library/sharedNetworkMessages/src/shared/clientGameServer/AcceptAuctionMessage.{h,cpp}
 */

import type { IByteStream, IReadIterator } from '../../../archive/interface.js';
import { NetworkIdCodec } from '../../../archive/network-id.js';
import type { NetworkId } from '../../../types.js';
import { GameNetworkMessage, asDecoder, defineMessageMeta } from '../../base.js';
import { registerMessage } from '../../registry.js';

const META = defineMessageMeta('AcceptAuctionMessage');

export class AcceptAuctionMessage extends GameNetworkMessage {
  static override readonly messageName = META.messageName;
  static readonly typeCrc = META.typeCrc;
  /** cmd + itemId */
  static override readonly varCount = 2;

  constructor(public readonly itemId: NetworkId) {
    super();
  }

  encodePayload(stream: IByteStream): void {
    NetworkIdCodec.encode(stream, this.itemId);
  }

  static decodePayload(iter: IReadIterator): AcceptAuctionMessage {
    return new AcceptAuctionMessage(NetworkIdCodec.decode(iter));
  }
}

export const AcceptAuctionMessageDecoder = registerMessage(asDecoder(AcceptAuctionMessage));
