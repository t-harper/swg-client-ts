/**
 * CreateAuctionResponseMessage — server-to-client. Confirms (or rejects)
 * a `CreateAuctionMessage` / `CreateImmediateAuctionMessage`.
 * `itemRestrictedRejectionMessage` is the optional human-readable string
 * shown to the user when `result == AuctionResult.ITEM_RESTRICTED`.
 *
 * Wire layout (addVariable order from CreateAuctionResponseMessage.cpp:24-26):
 *   [NetworkId]    itemId
 *   [i32]          result
 *   [std::string]  itemRestrictedRejectionMessage
 *
 * Source:
 *   /home/tharper/code/swg-main/src/engine/shared/library/sharedNetworkMessages/src/shared/clientGameServer/CreateAuctionResponseMessage.{h,cpp}
 */

import type { IByteStream, IReadIterator } from '../../../archive/interface.js';
import { NetworkIdCodec } from '../../../archive/network-id.js';
import { readStdString, writeStdString } from '../../../archive/string.js';
import type { NetworkId } from '../../../types.js';
import { GameNetworkMessage, asDecoder, defineMessageMeta } from '../../base.js';
import { registerMessage } from '../../registry.js';

const META = defineMessageMeta('CreateAuctionResponseMessage');

export class CreateAuctionResponseMessage extends GameNetworkMessage {
  static override readonly messageName = META.messageName;
  static readonly typeCrc = META.typeCrc;
  /** cmd + itemId + result + itemRestrictedRejectionMessage */
  static override readonly varCount = 4;

  constructor(
    public readonly itemId: NetworkId,
    public readonly result: number,
    public readonly itemRestrictedRejectionMessage: string,
  ) {
    super();
  }

  encodePayload(stream: IByteStream): void {
    NetworkIdCodec.encode(stream, this.itemId);
    stream.writeI32(this.result);
    writeStdString(stream, this.itemRestrictedRejectionMessage);
  }

  static decodePayload(iter: IReadIterator): CreateAuctionResponseMessage {
    const itemId = NetworkIdCodec.decode(iter);
    const result = iter.readI32();
    const itemRestrictedRejectionMessage = readStdString(iter);
    return new CreateAuctionResponseMessage(itemId, result, itemRestrictedRejectionMessage);
  }
}

export const CreateAuctionResponseMessageDecoder = registerMessage(
  asDecoder(CreateAuctionResponseMessage),
);
