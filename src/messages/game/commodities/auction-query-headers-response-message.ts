/**
 * AuctionQueryHeadersResponseMessage — server-to-client. Reply to
 * `AuctionQueryHeadersMessage`. Carries one page of headers (item summaries)
 * for the browse UI.
 *
 * Wire layout (addVariable order from AuctionQueryHeadersResponseMessage.cpp:29-36
 * and the mirror unpack at lines 49-55):
 *   [i32]                                requestId
 *   [i32]                                typeFlag
 *   [AutoArray<std::string>]             stringPalette        (u32 count + strings)
 *   [AutoArray<Unicode::String>]         wideStringPalette    (u32 count + ustrings)
 *   [AutoArray<PalettizedItemDataHeader>] palettizedAuctionData
 *   [u16]                                queryOffset
 *   [bool]                               hasMorePages
 *
 * `PalettizedItemDataHeader` wire (from AuctionQueryHeadersResponseMessage.cpp:177-215):
 *   [NetworkId] itemId
 *   [u8]        itemNameKey               (index into wideStringPalette)
 *   [i32]       highBid
 *   [i32]       timer
 *   [i32]       buyNowPrice
 *   [u16]       locationKey               (index into stringPalette)
 *   [NetworkId] ownerId
 *   [u16]       ownerNameKey              (index into stringPalette)
 *   [NetworkId] highBidderId
 *   [u16]       highBidderNameKey         (index into stringPalette)
 *   [i32]       maxProxyBid
 *   [i32]       myBid
 *   [i32]       itemType                  (C++ `long` → 4 bytes LE on 32-bit server)
 *   [i32]       resourceContainerClassCrc
 *   [i32]       flags
 *   [i32]       entranceCharge
 *
 * The decoder resolves the palette indices on read; `decoded.listings` is
 * the depalettized `AuctionListing[]` (full strings inline). Encode-side is
 * the inverse: we rebuild the palettes on the fly, deduping repeats.
 *
 * Source:
 *   /home/tharper/code/swg-main/src/engine/shared/library/sharedNetworkMessages/src/shared/clientGameServer/AuctionQueryHeadersResponseMessage.{h,cpp}
 *   /home/tharper/code/swg-main/src/engine/shared/library/sharedNetworkMessages/src/shared/clientGameServer/AuctionData.h
 */

import type { IByteStream, IReadIterator } from '../../../archive/interface.js';
import { NetworkIdCodec } from '../../../archive/network-id.js';
import { readStdString, writeStdString } from '../../../archive/string.js';
import { readUnicodeString, writeUnicodeString } from '../../../archive/unicode-string.js';
import type { NetworkId } from '../../../types.js';
import { GameNetworkMessage, asDecoder, defineMessageMeta } from '../../base.js';
import { registerMessage } from '../../registry.js';

export interface AuctionListing {
  itemId: NetworkId;
  itemName: string;
  highBid: number;
  timer: number;
  buyNowPrice: number;
  location: string;
  ownerId: NetworkId;
  ownerName: string;
  highBidderId: NetworkId;
  highBidderName: string;
  maxProxyBid: number;
  myBid: number;
  itemType: number;
  resourceContainerClassCrc: number;
  flags: number;
  entranceCharge: number;
}

interface PalettizedHeader {
  itemId: NetworkId;
  itemNameKey: number;
  highBid: number;
  timer: number;
  buyNowPrice: number;
  locationKey: number;
  ownerId: NetworkId;
  ownerNameKey: number;
  highBidderId: NetworkId;
  highBidderNameKey: number;
  maxProxyBid: number;
  myBid: number;
  itemType: number;
  resourceContainerClassCrc: number;
  flags: number;
  entranceCharge: number;
}

const META = defineMessageMeta('AuctionQueryHeadersResponseMessage');

export class AuctionQueryHeadersResponseMessage extends GameNetworkMessage {
  static override readonly messageName = META.messageName;
  static readonly typeCrc = META.typeCrc;
  /** cmd + requestId + typeFlag + stringPalette + wideStringPalette + palettizedAuctionData + queryOffset + hasMorePages */
  static override readonly varCount = 8;

  constructor(
    public readonly requestId: number,
    public readonly typeFlag: number,
    public readonly listings: readonly AuctionListing[],
    public readonly queryOffset: number,
    public readonly hasMorePages: boolean,
  ) {
    super();
  }

  encodePayload(stream: IByteStream): void {
    const stringPalette: string[] = [];
    const stringIndex = new Map<string, number>();
    const widePalette: string[] = [];
    const wideIndex = new Map<string, number>();

    const internNarrow = (s: string): number => {
      const existing = stringIndex.get(s);
      if (existing !== undefined) return existing;
      const idx = stringPalette.length;
      stringPalette.push(s);
      stringIndex.set(s, idx);
      return idx;
    };
    const internWide = (s: string): number => {
      const existing = wideIndex.get(s);
      if (existing !== undefined) return existing;
      const idx = widePalette.length;
      widePalette.push(s);
      wideIndex.set(s, idx);
      return idx;
    };

    const palettized: PalettizedHeader[] = this.listings.map((h) => ({
      itemId: h.itemId,
      itemNameKey: internWide(h.itemName) & 0xff,
      highBid: h.highBid,
      timer: h.timer,
      buyNowPrice: h.buyNowPrice,
      locationKey: internNarrow(h.location),
      ownerId: h.ownerId,
      ownerNameKey: internNarrow(h.ownerName),
      highBidderId: h.highBidderId,
      highBidderNameKey: internNarrow(h.highBidderName),
      maxProxyBid: h.maxProxyBid,
      myBid: h.myBid,
      itemType: h.itemType,
      resourceContainerClassCrc: h.resourceContainerClassCrc,
      flags: h.flags,
      entranceCharge: h.entranceCharge,
    }));

    stream.writeI32(this.requestId);
    stream.writeI32(this.typeFlag);
    stream.writeU32(stringPalette.length);
    for (const s of stringPalette) writeStdString(stream, s);
    stream.writeU32(widePalette.length);
    for (const s of widePalette) writeUnicodeString(stream, s);
    stream.writeU32(palettized.length);
    for (const h of palettized) writePalettized(stream, h);
    stream.writeU16(this.queryOffset);
    stream.writeBool(this.hasMorePages);
  }

  static decodePayload(iter: IReadIterator): AuctionQueryHeadersResponseMessage {
    const requestId = iter.readI32();
    const typeFlag = iter.readI32();
    const sp = iter.readU32();
    const stringPalette: string[] = [];
    for (let i = 0; i < sp; i++) stringPalette.push(readStdString(iter));
    const wp = iter.readU32();
    const widePalette: string[] = [];
    for (let i = 0; i < wp; i++) widePalette.push(readUnicodeString(iter));
    const ap = iter.readU32();
    const palettized: PalettizedHeader[] = [];
    for (let i = 0; i < ap; i++) palettized.push(readPalettized(iter));
    const queryOffset = iter.readU16();
    const hasMorePages = iter.readBool();

    const listings: AuctionListing[] = palettized.map((h) => ({
      itemId: h.itemId,
      itemName: widePalette[h.itemNameKey] ?? '',
      highBid: h.highBid,
      timer: h.timer,
      buyNowPrice: h.buyNowPrice,
      location: stringPalette[h.locationKey] ?? '',
      ownerId: h.ownerId,
      ownerName: stringPalette[h.ownerNameKey] ?? '',
      highBidderId: h.highBidderId,
      highBidderName: stringPalette[h.highBidderNameKey] ?? '',
      maxProxyBid: h.maxProxyBid,
      myBid: h.myBid,
      itemType: h.itemType,
      resourceContainerClassCrc: h.resourceContainerClassCrc,
      flags: h.flags,
      entranceCharge: h.entranceCharge,
    }));

    return new AuctionQueryHeadersResponseMessage(
      requestId,
      typeFlag,
      listings,
      queryOffset,
      hasMorePages,
    );
  }
}

function writePalettized(stream: IByteStream, h: PalettizedHeader): void {
  NetworkIdCodec.encode(stream, h.itemId);
  stream.writeU8(h.itemNameKey);
  stream.writeI32(h.highBid);
  stream.writeI32(h.timer);
  stream.writeI32(h.buyNowPrice);
  stream.writeU16(h.locationKey);
  NetworkIdCodec.encode(stream, h.ownerId);
  stream.writeU16(h.ownerNameKey);
  NetworkIdCodec.encode(stream, h.highBidderId);
  stream.writeU16(h.highBidderNameKey);
  stream.writeI32(h.maxProxyBid);
  stream.writeI32(h.myBid);
  stream.writeI32(h.itemType);
  stream.writeI32(h.resourceContainerClassCrc);
  stream.writeI32(h.flags);
  stream.writeI32(h.entranceCharge);
}

function readPalettized(iter: IReadIterator): PalettizedHeader {
  const itemId = NetworkIdCodec.decode(iter);
  const itemNameKey = iter.readU8();
  const highBid = iter.readI32();
  const timer = iter.readI32();
  const buyNowPrice = iter.readI32();
  const locationKey = iter.readU16();
  const ownerId = NetworkIdCodec.decode(iter);
  const ownerNameKey = iter.readU16();
  const highBidderId = NetworkIdCodec.decode(iter);
  const highBidderNameKey = iter.readU16();
  const maxProxyBid = iter.readI32();
  const myBid = iter.readI32();
  const itemType = iter.readI32();
  const resourceContainerClassCrc = iter.readI32();
  const flags = iter.readI32();
  const entranceCharge = iter.readI32();
  return {
    itemId,
    itemNameKey,
    highBid,
    timer,
    buyNowPrice,
    locationKey,
    ownerId,
    ownerNameKey,
    highBidderId,
    highBidderNameKey,
    maxProxyBid,
    myBid,
    itemType,
    resourceContainerClassCrc,
    flags,
    entranceCharge,
  };
}

export const AuctionQueryHeadersResponseMessageDecoder = registerMessage(
  asDecoder(AuctionQueryHeadersResponseMessage),
);
