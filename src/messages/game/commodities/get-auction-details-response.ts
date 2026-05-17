/**
 * GetAuctionDetailsResponse — server-to-client. Response to
 * `GetAuctionDetails`. Carries one `Auction::ItemDataDetails` struct: the
 * item's user description, attribute property list, server template name,
 * and appearance string.
 *
 * Wire layout (addVariable order from GetAuctionDetailsResponse.cpp:22):
 *   [Auction::ItemDataDetails] details
 *
 * Where `Auction::ItemDataDetails` (from AuctionData.h:133-149) serializes
 * via the namespace-Archive `get`/`put` helpers at
 * GetAuctionDetailsResponse.cpp:48-62 as:
 *   [NetworkId]        itemId
 *   [Unicode::String]  userDescription
 *   [vector<pair<std::string, Unicode::String>>] propertyList
 *   [std::string]      templateName
 *   [std::string]      appearanceString
 *
 * Source:
 *   /home/tharper/code/swg-main/src/engine/shared/library/sharedNetworkMessages/src/shared/clientGameServer/GetAuctionDetailsResponse.{h,cpp}
 *   /home/tharper/code/swg-main/src/engine/shared/library/sharedNetworkMessages/src/shared/clientGameServer/AuctionData.h
 */

import type { IByteStream, IReadIterator } from '../../../archive/interface.js';
import { NetworkIdCodec } from '../../../archive/network-id.js';
import { readStdString, writeStdString } from '../../../archive/string.js';
import { readUnicodeString, writeUnicodeString } from '../../../archive/unicode-string.js';
import type { NetworkId } from '../../../types.js';
import { GameNetworkMessage, asDecoder, defineMessageMeta } from '../../base.js';
import { registerMessage } from '../../registry.js';

export interface AuctionItemDetails {
  itemId: NetworkId;
  userDescription: string;
  propertyList: ReadonlyArray<readonly [string, string]>;
  templateName: string;
  appearanceString: string;
}

const META = defineMessageMeta('GetAuctionDetailsResponse');

export class GetAuctionDetailsResponse extends GameNetworkMessage {
  static override readonly messageName = META.messageName;
  static readonly typeCrc = META.typeCrc;
  /** cmd + details */
  static override readonly varCount = 2;

  constructor(public readonly details: AuctionItemDetails) {
    super();
  }

  encodePayload(stream: IByteStream): void {
    NetworkIdCodec.encode(stream, this.details.itemId);
    writeUnicodeString(stream, this.details.userDescription);
    stream.writeI32(this.details.propertyList.length);
    for (const [k, v] of this.details.propertyList) {
      writeStdString(stream, k);
      writeUnicodeString(stream, v);
    }
    writeStdString(stream, this.details.templateName);
    writeStdString(stream, this.details.appearanceString);
  }

  static decodePayload(iter: IReadIterator): GetAuctionDetailsResponse {
    const itemId = NetworkIdCodec.decode(iter);
    const userDescription = readUnicodeString(iter);
    const n = iter.readI32();
    const propertyList: Array<readonly [string, string]> = [];
    for (let i = 0; i < n; i++) {
      const k = readStdString(iter);
      const v = readUnicodeString(iter);
      propertyList.push([k, v]);
    }
    const templateName = readStdString(iter);
    const appearanceString = readStdString(iter);
    return new GetAuctionDetailsResponse({
      itemId,
      userDescription,
      propertyList,
      templateName,
      appearanceString,
    });
  }
}

export const GetAuctionDetailsResponseDecoder = registerMessage(
  asDecoder(GetAuctionDetailsResponse),
);
