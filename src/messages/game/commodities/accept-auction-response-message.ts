/**
 * AcceptAuctionResponseMessage — server-to-client. Confirms an
 * `AcceptAuctionMessage`. `result` is an `AuctionResult` code.
 *
 * Wire layout (addVariable order from AcceptAuctionResponseMessage.cpp:23-24):
 *   [NetworkId] itemId
 *   [i32]       result
 *
 * Source:
 *   /home/tharper/code/swg-main/src/engine/shared/library/sharedNetworkMessages/src/shared/clientGameServer/AcceptAuctionResponseMessage.{h,cpp}
 */

import type { IByteStream, IReadIterator } from '../../../archive/interface.js';
import { NetworkIdCodec } from '../../../archive/network-id.js';
import type { NetworkId } from '../../../types.js';
import { GameNetworkMessage, asDecoder, defineMessageMeta } from '../../base.js';
import { registerMessage } from '../../registry.js';

const META = defineMessageMeta('AcceptAuctionResponseMessage');

export class AcceptAuctionResponseMessage extends GameNetworkMessage {
  static override readonly messageName = META.messageName;
  static readonly typeCrc = META.typeCrc;
  /** cmd + itemId + result */
  static override readonly varCount = 3;

  constructor(
    public readonly itemId: NetworkId,
    public readonly result: number,
  ) {
    super();
  }

  encodePayload(stream: IByteStream): void {
    NetworkIdCodec.encode(stream, this.itemId);
    stream.writeI32(this.result);
  }

  static decodePayload(iter: IReadIterator): AcceptAuctionResponseMessage {
    const itemId = NetworkIdCodec.decode(iter);
    const result = iter.readI32();
    return new AcceptAuctionResponseMessage(itemId, result);
  }
}

export const AcceptAuctionResponseMessageDecoder = registerMessage(
  asDecoder(AcceptAuctionResponseMessage),
);
