import { describe, expect, it } from 'vitest';

import { encodeMessage, parseHeader } from '../../base.js';
import { AuctionFlags } from './auction-error-codes.js';
import {
  type AuctionListing,
  AuctionQueryHeadersResponseMessage,
} from './auction-query-headers-response-message.js';

import './auction-query-headers-response-message.js';

const SAMPLE_LISTING: AuctionListing = {
  itemId: 0xabc1n,
  itemName: 'Krayt Pearl',
  highBid: 12_500,
  timer: 3600,
  buyNowPrice: 0,
  location: 'tatooine.mos_eisley.bazaar.7',
  ownerId: 0x100n,
  ownerName: 'han',
  highBidderId: 0x200n,
  highBidderName: 'luke',
  maxProxyBid: 20_000,
  myBid: 0,
  itemType: 4096,
  resourceContainerClassCrc: 0,
  flags: AuctionFlags.ACTIVE | AuctionFlags.PREMIUM_AUCTION,
  entranceCharge: 0,
};

describe('AuctionQueryHeadersResponseMessage', () => {
  it('has the expected metadata', () => {
    expect(AuctionQueryHeadersResponseMessage.messageName).toBe(
      'AuctionQueryHeadersResponseMessage',
    );
    expect(AuctionQueryHeadersResponseMessage.varCount).toBe(8);
    expect(AuctionQueryHeadersResponseMessage.typeCrc).toBeGreaterThan(0);
  });

  it('round-trips an empty page', () => {
    const msg = new AuctionQueryHeadersResponseMessage(1, 0, [], 0, false);
    const bytes = encodeMessage(msg);
    const { payload } = parseHeader(bytes);
    const decoded = AuctionQueryHeadersResponseMessage.decodePayload(payload);
    expect(decoded.requestId).toBe(1);
    expect(decoded.typeFlag).toBe(0);
    expect(decoded.listings).toHaveLength(0);
    expect(decoded.queryOffset).toBe(0);
    expect(decoded.hasMorePages).toBe(false);
  });

  it('round-trips a single listing with depalettization', () => {
    const msg = new AuctionQueryHeadersResponseMessage(42, 1, [SAMPLE_LISTING], 0, true);
    const bytes = encodeMessage(msg);
    const { payload } = parseHeader(bytes);
    const decoded = AuctionQueryHeadersResponseMessage.decodePayload(payload);
    expect(decoded.requestId).toBe(42);
    expect(decoded.hasMorePages).toBe(true);
    expect(decoded.listings).toHaveLength(1);
    const l = decoded.listings[0];
    if (!l) throw new Error('expected listing');
    expect(l.itemId).toBe(SAMPLE_LISTING.itemId);
    expect(l.itemName).toBe(SAMPLE_LISTING.itemName);
    expect(l.highBid).toBe(SAMPLE_LISTING.highBid);
    expect(l.location).toBe(SAMPLE_LISTING.location);
    expect(l.ownerName).toBe(SAMPLE_LISTING.ownerName);
    expect(l.highBidderName).toBe(SAMPLE_LISTING.highBidderName);
    expect(l.flags).toBe(SAMPLE_LISTING.flags);
  });

  it('dedupes palette entries across multiple listings with shared owner/location', () => {
    const listings: AuctionListing[] = [
      { ...SAMPLE_LISTING, itemId: 0x1n, ownerName: 'han', highBidderName: 'luke' },
      { ...SAMPLE_LISTING, itemId: 0x2n, ownerName: 'han', highBidderName: 'luke' },
      { ...SAMPLE_LISTING, itemId: 0x3n, ownerName: 'han', highBidderName: 'luke' },
    ];
    const msg = new AuctionQueryHeadersResponseMessage(0, 0, listings, 0, false);
    const bytes = encodeMessage(msg);
    const { payload } = parseHeader(bytes);
    const decoded = AuctionQueryHeadersResponseMessage.decodePayload(payload);
    expect(decoded.listings).toHaveLength(3);
    for (const l of decoded.listings) {
      expect(l.ownerName).toBe('han');
      expect(l.highBidderName).toBe('luke');
    }
  });

  it('round-trips a multi-listing page with varied strings', () => {
    const listings: AuctionListing[] = [
      { ...SAMPLE_LISTING, itemId: 0x10n, itemName: 'Sword A', ownerName: 'alice' },
      { ...SAMPLE_LISTING, itemId: 0x20n, itemName: 'Sword B', ownerName: 'bob' },
      { ...SAMPLE_LISTING, itemId: 0x30n, itemName: 'Sword C', ownerName: 'carol' },
    ];
    const msg = new AuctionQueryHeadersResponseMessage(99, 1, listings, 30, true);
    const bytes = encodeMessage(msg);
    const { payload } = parseHeader(bytes);
    const decoded = AuctionQueryHeadersResponseMessage.decodePayload(payload);
    expect(decoded.queryOffset).toBe(30);
    expect(decoded.hasMorePages).toBe(true);
    expect(decoded.listings[0]?.ownerName).toBe('alice');
    expect(decoded.listings[1]?.ownerName).toBe('bob');
    expect(decoded.listings[2]?.ownerName).toBe('carol');
    expect(decoded.listings[0]?.itemName).toBe('Sword A');
    expect(decoded.listings[1]?.itemName).toBe('Sword B');
    expect(decoded.listings[2]?.itemName).toBe('Sword C');
  });
});
