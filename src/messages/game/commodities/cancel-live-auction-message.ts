/**
 * CancelLiveAuctionMessage — client-to-server. Cancel one of your own live
 * auctions or vendor listings.
 *
 * Wire layout (addVariable order from CancelLiveAuctionMessage.cpp:18):
 *   [NetworkId] itemId
 *
 * Source:
 *   /home/tharper/code/swg-main/src/engine/shared/library/sharedNetworkMessages/src/shared/clientGameServer/CancelLiveAuctionMessage.{h,cpp}
 */

import type { IByteStream, IReadIterator } from '../../../archive/interface.js';
import { NetworkIdCodec } from '../../../archive/network-id.js';
import type { NetworkId } from '../../../types.js';
import { GameNetworkMessage, asDecoder, defineMessageMeta } from '../../base.js';
import { registerMessage } from '../../registry.js';

const META = defineMessageMeta('CancelLiveAuctionMessage');

export class CancelLiveAuctionMessage extends GameNetworkMessage {
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

  static decodePayload(iter: IReadIterator): CancelLiveAuctionMessage {
    return new CancelLiveAuctionMessage(NetworkIdCodec.decode(iter));
  }
}

export const CancelLiveAuctionMessageDecoder = registerMessage(asDecoder(CancelLiveAuctionMessage));
