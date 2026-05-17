/**
 * CreateImmediateAuctionMessage — client-to-server. List an item for
 * instant-buy sale at a fixed `price`. `vendorTransfer` is true when the
 * caller is moving the item between vendors (not a new sale).
 *
 * Wire layout (addVariable order from CreateImmediateAuctionMessage.cpp:25-32):
 *   [NetworkId]        itemId
 *   [Unicode::String]  itemLocalizedName
 *   [NetworkId]        containerId
 *   [i32]              price
 *   [i32]              auctionLength
 *   [Unicode::String]  userDescription
 *   [bool]             premium
 *   [bool]             vendorTransfer
 *
 * Source:
 *   /home/tharper/code/swg-main/src/engine/shared/library/sharedNetworkMessages/src/shared/clientGameServer/CreateImmediateAuctionMessage.{h,cpp}
 */

import type { IByteStream, IReadIterator } from '../../../archive/interface.js';
import { NetworkIdCodec } from '../../../archive/network-id.js';
import { readUnicodeString, writeUnicodeString } from '../../../archive/unicode-string.js';
import type { NetworkId } from '../../../types.js';
import { GameNetworkMessage, asDecoder, defineMessageMeta } from '../../base.js';
import { registerMessage } from '../../registry.js';

const META = defineMessageMeta('CreateImmediateAuctionMessage');

export class CreateImmediateAuctionMessage extends GameNetworkMessage {
  static override readonly messageName = META.messageName;
  static readonly typeCrc = META.typeCrc;
  /** cmd + itemId + itemLocalizedName + containerId + price + auctionLength + userDescription + premium + vendorTransfer */
  static override readonly varCount = 9;

  constructor(
    public readonly itemId: NetworkId,
    public readonly itemLocalizedName: string,
    public readonly containerId: NetworkId,
    public readonly price: number,
    public readonly auctionLength: number,
    public readonly userDescription: string,
    public readonly premium: boolean,
    public readonly vendorTransfer: boolean,
  ) {
    super();
  }

  encodePayload(stream: IByteStream): void {
    NetworkIdCodec.encode(stream, this.itemId);
    writeUnicodeString(stream, this.itemLocalizedName);
    NetworkIdCodec.encode(stream, this.containerId);
    stream.writeI32(this.price);
    stream.writeI32(this.auctionLength);
    writeUnicodeString(stream, this.userDescription);
    stream.writeBool(this.premium);
    stream.writeBool(this.vendorTransfer);
  }

  static decodePayload(iter: IReadIterator): CreateImmediateAuctionMessage {
    const itemId = NetworkIdCodec.decode(iter);
    const itemLocalizedName = readUnicodeString(iter);
    const containerId = NetworkIdCodec.decode(iter);
    const price = iter.readI32();
    const auctionLength = iter.readI32();
    const userDescription = readUnicodeString(iter);
    const premium = iter.readBool();
    const vendorTransfer = iter.readBool();
    return new CreateImmediateAuctionMessage(
      itemId,
      itemLocalizedName,
      containerId,
      price,
      auctionLength,
      userDescription,
      premium,
      vendorTransfer,
    );
  }
}

export const CreateImmediateAuctionMessageDecoder = registerMessage(
  asDecoder(CreateImmediateAuctionMessage),
);
