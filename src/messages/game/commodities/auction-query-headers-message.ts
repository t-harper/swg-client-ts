/**
 * AuctionQueryHeadersMessage — client-to-server. Drives the bazaar browse
 * UI: pick a search location/category and optional text/price filters; the
 * server responds with `AuctionQueryHeadersResponseMessage`.
 *
 * Wire layout (addVariable order from AuctionQueryHeadersMessage.cpp:114-129):
 *   [i32]                  locationSearchType   (AuctionLocationSearch)
 *   [i32]                  requestId
 *   [i32]                  searchType           (AuctionSearchType)
 *   [i32]                  itemType
 *   [bool]                 itemTypeExactMatch
 *   [i32]                  itemTemplateId
 *   [Unicode::String]      textFilterAll
 *   [Unicode::String]      textFilterAny
 *   [i32]                  priceFilterMin
 *   [i32]                  priceFilterMax
 *   [bool]                 priceFilterIncludesFee
 *   [list<SearchCondition>] advancedSearch       (encoded as `vector<T>`: int32 count + items)
 *   [i8]                   advancedSearchMatchAllAny
 *   [NetworkId]            container
 *   [bool]                 myVendorsOnly
 *   [u16]                  queryOffset
 *
 * SearchCondition wire (from AuctionQueryHeadersMessage.cpp:48-71):
 *   [u32]   attributeNameCrc
 *   [bool]  requiredAttribute
 *   [i8]    comparison (SCC_int=0, SCC_float=1, SCC_string_equal=2, ...)
 *   THEN, conditional on comparison:
 *     SCC_int               → [i32 intMin][i32 intMax]
 *     SCC_float             → [f64 floatMin][f64 floatMax]
 *     SCC_string_*          → [std::string stringValue]
 *
 * Source:
 *   /home/tharper/code/swg-main/src/engine/shared/library/sharedNetworkMessages/src/shared/clientGameServer/AuctionQueryHeadersMessage.{h,cpp}
 */

import type { IByteStream, IReadIterator } from '../../../archive/interface.js';
import { NetworkIdCodec } from '../../../archive/network-id.js';
import { readStdString, writeStdString } from '../../../archive/string.js';
import { readUnicodeString, writeUnicodeString } from '../../../archive/unicode-string.js';
import type { NetworkId } from '../../../types.js';
import { GameNetworkMessage, asDecoder, defineMessageMeta } from '../../base.js';
import { registerMessage } from '../../registry.js';

export const AuctionSearchType = {
  ByCategory: 0,
  ByLocation: 1,
  ByAll: 2,
  ByPlayerSales: 3,
  ByPlayerBids: 4,
  ByPlayerStockroom: 5,
  ByVendorOffers: 6,
  ByVendorSelling: 7,
  ByVendorStockroom: 8,
  ByPlayerOffersToVendor: 9,
} as const;

export const AuctionLocationSearch = {
  Galaxy: 0,
  Planet: 1,
  Region: 2,
  Market: 3,
} as const;

export const SearchConditionComparison = {
  SCC_int: 0,
  SCC_float: 1,
  SCC_string_equal: 2,
  SCC_string_not_equal: 3,
  SCC_string_contain: 4,
  SCC_string_not_contain: 5,
} as const;

export const AdvancedSearchMatchAllAny = {
  match_all: 0,
  match_any: 1,
  not_match_all: 2,
  not_match_any: 3,
} as const;

export interface SearchCondition {
  attributeNameCrc: number;
  requiredAttribute: boolean;
  comparison: number;
  intMin: number;
  intMax: number;
  floatMin: number;
  floatMax: number;
  stringValue: string;
}

function writeSearchCondition(stream: IByteStream, cond: SearchCondition): void {
  stream.writeU32(cond.attributeNameCrc);
  stream.writeBool(cond.requiredAttribute);
  stream.writeI8(cond.comparison);
  if (cond.comparison === SearchConditionComparison.SCC_int) {
    stream.writeI32(cond.intMin);
    stream.writeI32(cond.intMax);
  } else if (cond.comparison === SearchConditionComparison.SCC_float) {
    stream.writeF64(cond.floatMin);
    stream.writeF64(cond.floatMax);
  } else if (
    cond.comparison === SearchConditionComparison.SCC_string_equal ||
    cond.comparison === SearchConditionComparison.SCC_string_not_equal ||
    cond.comparison === SearchConditionComparison.SCC_string_contain ||
    cond.comparison === SearchConditionComparison.SCC_string_not_contain
  ) {
    writeStdString(stream, cond.stringValue);
  }
}

function readSearchCondition(iter: IReadIterator): SearchCondition {
  const attributeNameCrc = iter.readU32();
  const requiredAttribute = iter.readBool();
  let comparison = iter.readI8();
  let intMin = 0;
  let intMax = 0;
  let floatMin = 0;
  let floatMax = 0;
  let stringValue = '';
  if (comparison === SearchConditionComparison.SCC_int) {
    intMin = iter.readI32();
    intMax = iter.readI32();
  } else if (comparison === SearchConditionComparison.SCC_float) {
    floatMin = iter.readF64();
    floatMax = iter.readF64();
  } else if (
    comparison === SearchConditionComparison.SCC_string_equal ||
    comparison === SearchConditionComparison.SCC_string_not_equal ||
    comparison === SearchConditionComparison.SCC_string_contain ||
    comparison === SearchConditionComparison.SCC_string_not_contain
  ) {
    stringValue = readStdString(iter);
  } else {
    comparison = SearchConditionComparison.SCC_int;
  }
  return {
    attributeNameCrc,
    requiredAttribute,
    comparison,
    intMin,
    intMax,
    floatMin,
    floatMax,
    stringValue,
  };
}

export interface AuctionQueryHeadersFields {
  locationSearchType: number;
  requestId: number;
  searchType: number;
  itemType: number;
  itemTypeExactMatch: boolean;
  itemTemplateId: number;
  textFilterAll: string;
  textFilterAny: string;
  priceFilterMin: number;
  priceFilterMax: number;
  priceFilterIncludesFee: boolean;
  advancedSearch: readonly SearchCondition[];
  advancedSearchMatchAllAny: number;
  container: NetworkId;
  myVendorsOnly: boolean;
  queryOffset: number;
}

const META = defineMessageMeta('AuctionQueryHeadersMessage');

export class AuctionQueryHeadersMessage extends GameNetworkMessage {
  static override readonly messageName = META.messageName;
  static readonly typeCrc = META.typeCrc;
  /** cmd + 16 payload fields */
  static override readonly varCount = 17;

  constructor(public readonly fields: AuctionQueryHeadersFields) {
    super();
  }

  encodePayload(stream: IByteStream): void {
    const f = this.fields;
    stream.writeI32(f.locationSearchType);
    stream.writeI32(f.requestId);
    stream.writeI32(f.searchType);
    stream.writeI32(f.itemType);
    stream.writeBool(f.itemTypeExactMatch);
    stream.writeI32(f.itemTemplateId);
    writeUnicodeString(stream, f.textFilterAll);
    writeUnicodeString(stream, f.textFilterAny);
    stream.writeI32(f.priceFilterMin);
    stream.writeI32(f.priceFilterMax);
    stream.writeBool(f.priceFilterIncludesFee);
    stream.writeI32(f.advancedSearch.length);
    for (const c of f.advancedSearch) writeSearchCondition(stream, c);
    stream.writeI8(f.advancedSearchMatchAllAny);
    NetworkIdCodec.encode(stream, f.container);
    stream.writeBool(f.myVendorsOnly);
    stream.writeU16(f.queryOffset);
  }

  static decodePayload(iter: IReadIterator): AuctionQueryHeadersMessage {
    const locationSearchType = iter.readI32();
    const requestId = iter.readI32();
    const searchType = iter.readI32();
    const itemType = iter.readI32();
    const itemTypeExactMatch = iter.readBool();
    const itemTemplateId = iter.readI32();
    const textFilterAll = readUnicodeString(iter);
    const textFilterAny = readUnicodeString(iter);
    const priceFilterMin = iter.readI32();
    const priceFilterMax = iter.readI32();
    const priceFilterIncludesFee = iter.readBool();
    const n = iter.readI32();
    const advancedSearch: SearchCondition[] = [];
    for (let i = 0; i < n; i++) advancedSearch.push(readSearchCondition(iter));
    const advancedSearchMatchAllAny = iter.readI8();
    const container = NetworkIdCodec.decode(iter);
    const myVendorsOnly = iter.readBool();
    const queryOffset = iter.readU16();
    return new AuctionQueryHeadersMessage({
      locationSearchType,
      requestId,
      searchType,
      itemType,
      itemTypeExactMatch,
      itemTemplateId,
      textFilterAll,
      textFilterAny,
      priceFilterMin,
      priceFilterMax,
      priceFilterIncludesFee,
      advancedSearch,
      advancedSearchMatchAllAny,
      container,
      myVendorsOnly,
      queryOffset,
    });
  }
}

export const AuctionQueryHeadersMessageDecoder = registerMessage(
  asDecoder(AuctionQueryHeadersMessage),
);
