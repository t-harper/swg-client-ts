/**
 * RetrieveAuctionItemMessage — client-to-server. Pull a won / expired /
 * cancelled item out of bazaar limbo back into your inventory.
 *
 * Wire layout (addVariable order from RetrieveAuctionItemMessage.cpp:19-20):
 *   [NetworkId] itemId
 *   [NetworkId] containerId   (the bazaar terminal)
 *
 * Source:
 *   /home/tharper/code/swg-main/src/engine/shared/library/sharedNetworkMessages/src/shared/clientGameServer/RetrieveAuctionItemMessage.{h,cpp}
 */

import type { IByteStream, IReadIterator } from '../../../archive/interface.js';
import { NetworkIdCodec } from '../../../archive/network-id.js';
import type { NetworkId } from '../../../types.js';
import { GameNetworkMessage, asDecoder, defineMessageMeta } from '../../base.js';
import { registerMessage } from '../../registry.js';

const META = defineMessageMeta('RetrieveAuctionItemMessage');

export class RetrieveAuctionItemMessage extends GameNetworkMessage {
  static override readonly messageName = META.messageName;
  static readonly typeCrc = META.typeCrc;
  /** cmd + itemId + containerId */
  static override readonly varCount = 3;

  constructor(
    public readonly itemId: NetworkId,
    public readonly containerId: NetworkId,
  ) {
    super();
  }

  encodePayload(stream: IByteStream): void {
    NetworkIdCodec.encode(stream, this.itemId);
    NetworkIdCodec.encode(stream, this.containerId);
  }

  static decodePayload(iter: IReadIterator): RetrieveAuctionItemMessage {
    const itemId = NetworkIdCodec.decode(iter);
    const containerId = NetworkIdCodec.decode(iter);
    return new RetrieveAuctionItemMessage(itemId, containerId);
  }
}

export const RetrieveAuctionItemMessageDecoder = registerMessage(
  asDecoder(RetrieveAuctionItemMessage),
);
