/**
 * CancelLiveAuctionResponseMessage — server-to-client. Confirms a
 * `CancelLiveAuctionMessage`. `vendorRefusal` is set when a vendor's owner
 * refused (rather than the auction completing normally).
 *
 * Wire layout (addVariable order from CancelLiveAuctionResponseMessage.cpp:24-26):
 *   [NetworkId] itemId
 *   [i32]       result
 *   [bool]      vendorRefusal
 *
 * Source:
 *   /home/tharper/code/swg-main/src/engine/shared/library/sharedNetworkMessages/src/shared/clientGameServer/CancelLiveAuctionResponseMessage.{h,cpp}
 */

import type { IByteStream, IReadIterator } from '../../../archive/interface.js';
import { NetworkIdCodec } from '../../../archive/network-id.js';
import type { NetworkId } from '../../../types.js';
import { GameNetworkMessage, asDecoder, defineMessageMeta } from '../../base.js';
import { registerMessage } from '../../registry.js';

const META = defineMessageMeta('CancelLiveAuctionResponseMessage');

export class CancelLiveAuctionResponseMessage extends GameNetworkMessage {
  static override readonly messageName = META.messageName;
  static readonly typeCrc = META.typeCrc;
  /** cmd + itemId + result + vendorRefusal */
  static override readonly varCount = 4;

  constructor(
    public readonly itemId: NetworkId,
    public readonly result: number,
    public readonly vendorRefusal: boolean,
  ) {
    super();
  }

  encodePayload(stream: IByteStream): void {
    NetworkIdCodec.encode(stream, this.itemId);
    stream.writeI32(this.result);
    stream.writeBool(this.vendorRefusal);
  }

  static decodePayload(iter: IReadIterator): CancelLiveAuctionResponseMessage {
    const itemId = NetworkIdCodec.decode(iter);
    const result = iter.readI32();
    const vendorRefusal = iter.readBool();
    return new CancelLiveAuctionResponseMessage(itemId, result, vendorRefusal);
  }
}

export const CancelLiveAuctionResponseMessageDecoder = registerMessage(
  asDecoder(CancelLiveAuctionResponseMessage),
);
