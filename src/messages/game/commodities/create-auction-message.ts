/**
 * CreateAuctionMessage — client-to-server. List an item for bidding-style
 * auction at `containerId` (bazaar terminal). For instant-buy listings use
 * `CreateImmediateAuctionMessage` instead.
 *
 * Wire layout (addVariable order from CreateAuctionMessage.cpp:24-30):
 *   [NetworkId]        itemId
 *   [Unicode::String]  itemLocalizedName
 *   [NetworkId]        containerId
 *   [i32]              minimumBid
 *   [i32]              auctionLength      (seconds)
 *   [Unicode::String]  userDescription
 *   [bool]             premium            (premium listing fee)
 *
 * Source:
 *   /home/tharper/code/swg-main/src/engine/shared/library/sharedNetworkMessages/src/shared/clientGameServer/CreateAuctionMessage.{h,cpp}
 */

import type { IByteStream, IReadIterator } from '../../../archive/interface.js';
import { NetworkIdCodec } from '../../../archive/network-id.js';
import { readUnicodeString, writeUnicodeString } from '../../../archive/unicode-string.js';
import type { NetworkId } from '../../../types.js';
import { GameNetworkMessage, asDecoder, defineMessageMeta } from '../../base.js';
import { registerMessage } from '../../registry.js';

const META = defineMessageMeta('CreateAuctionMessage');

export class CreateAuctionMessage extends GameNetworkMessage {
  static override readonly messageName = META.messageName;
  static readonly typeCrc = META.typeCrc;
  /** cmd + itemId + itemLocalizedName + containerId + minimumBid + auctionLength + userDescription + premium */
  static override readonly varCount = 8;

  constructor(
    public readonly itemId: NetworkId,
    public readonly itemLocalizedName: string,
    public readonly containerId: NetworkId,
    public readonly minimumBid: number,
    public readonly auctionLength: number,
    public readonly userDescription: string,
    public readonly premium: boolean,
  ) {
    super();
  }

  encodePayload(stream: IByteStream): void {
    NetworkIdCodec.encode(stream, this.itemId);
    writeUnicodeString(stream, this.itemLocalizedName);
    NetworkIdCodec.encode(stream, this.containerId);
    stream.writeI32(this.minimumBid);
    stream.writeI32(this.auctionLength);
    writeUnicodeString(stream, this.userDescription);
    stream.writeBool(this.premium);
  }

  static decodePayload(iter: IReadIterator): CreateAuctionMessage {
    const itemId = NetworkIdCodec.decode(iter);
    const itemLocalizedName = readUnicodeString(iter);
    const containerId = NetworkIdCodec.decode(iter);
    const minimumBid = iter.readI32();
    const auctionLength = iter.readI32();
    const userDescription = readUnicodeString(iter);
    const premium = iter.readBool();
    return new CreateAuctionMessage(
      itemId,
      itemLocalizedName,
      containerId,
      minimumBid,
      auctionLength,
      userDescription,
      premium,
    );
  }
}

export const CreateAuctionMessageDecoder = registerMessage(asDecoder(CreateAuctionMessage));
