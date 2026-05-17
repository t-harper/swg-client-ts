/**
 * GetAuctionDetails — client-to-server. Request the description, attribute
 * list, and appearance string for a single auction's item.
 *
 * Wire layout (addVariable order from GetAuctionDetails.cpp:18):
 *   [NetworkId] itemId
 *
 * Source:
 *   /home/tharper/code/swg-main/src/engine/shared/library/sharedNetworkMessages/src/shared/clientGameServer/GetAuctionDetails.{h,cpp}
 */

import type { IByteStream, IReadIterator } from '../../../archive/interface.js';
import { NetworkIdCodec } from '../../../archive/network-id.js';
import type { NetworkId } from '../../../types.js';
import { GameNetworkMessage, asDecoder, defineMessageMeta } from '../../base.js';
import { registerMessage } from '../../registry.js';

const META = defineMessageMeta('GetAuctionDetails');

export class GetAuctionDetails extends GameNetworkMessage {
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

  static decodePayload(iter: IReadIterator): GetAuctionDetails {
    return new GetAuctionDetails(NetworkIdCodec.decode(iter));
  }
}

export const GetAuctionDetailsDecoder = registerMessage(asDecoder(GetAuctionDetails));
