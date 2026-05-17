import { describe, expect, it } from 'vitest';

import {
  AuctionFlags,
  type AuctionListing,
  AuctionLocationSearch,
  AuctionQueryHeadersMessage,
  AuctionQueryHeadersResponseMessage,
  AuctionResult,
  AuctionSearchType,
  BidAuctionMessage,
  CancelLiveAuctionMessage,
  CreateAuctionMessage,
  CreateAuctionResponseMessage,
  CreateImmediateAuctionMessage,
  GetAuctionDetails,
  GetAuctionDetailsResponse,
  RetrieveAuctionItemMessage,
} from '../../messages/game/commodities/index.js';
import { createFakeContext } from './test-helpers.js';

function listingOf(itemId: bigint, price: number, name = 'Item'): AuctionListing {
  return {
    itemId,
    itemName: name,
    highBid: price,
    timer: 3600,
    buyNowPrice: 0,
    location: 'tatooine.mos_eisley.bazaar.7',
    ownerId: 0x100n,
    ownerName: 'han',
    highBidderId: 0n,
    highBidderName: '',
    maxProxyBid: price,
    myBid: 0,
    itemType: 0,
    resourceContainerClassCrc: 0,
    flags: AuctionFlags.ACTIVE,
    entranceCharge: 0,
  };
}

describe('ScriptContext: commodities / bazaar primitives', () => {
  it('browseBazaar sends AuctionQueryHeadersMessage with sensible defaults', async () => {
    const { ctx, sent, simulateRecv } = createFakeContext();
    const browsePromise = ctx.browseBazaar(0xabc1n);

    // Drive the response.
    queueMicrotask(() => {
      simulateRecv(new AuctionQueryHeadersResponseMessage(1, 0, [listingOf(0x1n, 100)], 0, false));
    });

    const listings = await browsePromise;
    expect(listings).toHaveLength(1);
    expect(listings[0]?.itemId).toBe(0x1n);

    expect(sent.length).toBe(1);
    const sentMsg = sent[0];
    expect(sentMsg).toBeInstanceOf(AuctionQueryHeadersMessage);
    if (!(sentMsg instanceof AuctionQueryHeadersMessage)) throw new Error('typeguard');
    expect(sentMsg.fields.container).toBe(0xabc1n);
    expect(sentMsg.fields.searchType).toBe(AuctionSearchType.ByAll);
    expect(sentMsg.fields.locationSearchType).toBe(AuctionLocationSearch.Galaxy);
    expect(sentMsg.fields.requestId).toBe(1);
  });

  it('browseBazaar forwards user-supplied filters', async () => {
    const { ctx, sent, simulateRecv } = createFakeContext();
    const browsePromise = ctx.browseBazaar(0xabc1n, {
      searchType: AuctionSearchType.ByCategory,
      category: 256,
      itemTypeExactMatch: true,
      minPrice: 100,
      maxPrice: 5000,
      textFilterAll: 'rifle',
      myVendorsOnly: true,
      queryOffset: 30,
    });

    queueMicrotask(() => {
      simulateRecv(new AuctionQueryHeadersResponseMessage(1, 0, [], 0, false));
    });

    await browsePromise;

    const sentMsg = sent[0] as AuctionQueryHeadersMessage;
    expect(sentMsg.fields.searchType).toBe(AuctionSearchType.ByCategory);
    expect(sentMsg.fields.itemType).toBe(256);
    expect(sentMsg.fields.itemTypeExactMatch).toBe(true);
    expect(sentMsg.fields.priceFilterMin).toBe(100);
    expect(sentMsg.fields.priceFilterMax).toBe(5000);
    expect(sentMsg.fields.textFilterAll).toBe('rifle');
    expect(sentMsg.fields.myVendorsOnly).toBe(true);
    expect(sentMsg.fields.queryOffset).toBe(30);
  });

  it('browseBazaar matches only responses with the request id we sent', async () => {
    const { ctx, simulateRecv } = createFakeContext();
    const browsePromise = ctx.browseBazaar(0xabc1n);

    queueMicrotask(() => {
      simulateRecv(new AuctionQueryHeadersResponseMessage(999, 0, [], 0, false));
      simulateRecv(new AuctionQueryHeadersResponseMessage(1, 0, [listingOf(0x42n, 50)], 0, false));
    });

    const listings = await browsePromise;
    expect(listings).toHaveLength(1);
    expect(listings[0]?.itemId).toBe(0x42n);
  });

  it('browseBazaar auto-increments the request id across calls', async () => {
    const { ctx, sent, simulateRecv } = createFakeContext();

    queueMicrotask(() => {
      simulateRecv(new AuctionQueryHeadersResponseMessage(1, 0, [], 0, false));
    });
    await ctx.browseBazaar(0x1n);
    queueMicrotask(() => {
      simulateRecv(new AuctionQueryHeadersResponseMessage(2, 0, [], 0, false));
    });
    await ctx.browseBazaar(0x1n);

    const a = sent[0] as AuctionQueryHeadersMessage;
    const b = sent[1] as AuctionQueryHeadersMessage;
    expect(a.fields.requestId).toBe(1);
    expect(b.fields.requestId).toBe(2);
  });

  it('getAuctionDetails sends and awaits the matching response', async () => {
    const { ctx, sent, simulateRecv } = createFakeContext();
    const auctionId = 0xdeadbeefn;
    const detailsPromise = ctx.getAuctionDetails(auctionId);

    queueMicrotask(() => {
      simulateRecv(
        new GetAuctionDetailsResponse({
          itemId: auctionId,
          userDescription: 'Nice item',
          propertyList: [['damage', '+15']],
          templateName: 'object/weapon/rifle.iff',
          appearanceString: 'rifle.sat',
        }),
      );
    });

    const details = await detailsPromise;
    expect(details.itemId).toBe(auctionId);
    expect(details.userDescription).toBe('Nice item');
    expect(details.propertyList).toHaveLength(1);
    expect(details.templateName).toBe('object/weapon/rifle.iff');

    expect(sent.length).toBe(1);
    const sentMsg = sent[0];
    expect(sentMsg).toBeInstanceOf(GetAuctionDetails);
    if (!(sentMsg instanceof GetAuctionDetails)) throw new Error('typeguard');
    expect(sentMsg.itemId).toBe(auctionId);
  });

  it('getAuctionDetails ignores responses for other auction ids', async () => {
    const { ctx, simulateRecv } = createFakeContext();
    const targetId = 0xfeedn;
    const detailsPromise = ctx.getAuctionDetails(targetId);

    queueMicrotask(() => {
      simulateRecv(
        new GetAuctionDetailsResponse({
          itemId: 0xbadn,
          userDescription: 'wrong one',
          propertyList: [],
          templateName: '',
          appearanceString: '',
        }),
      );
      simulateRecv(
        new GetAuctionDetailsResponse({
          itemId: targetId,
          userDescription: 'correct',
          propertyList: [],
          templateName: '',
          appearanceString: '',
        }),
      );
    });

    const details = await detailsPromise;
    expect(details.itemId).toBe(targetId);
    expect(details.userDescription).toBe('correct');
  });

  it('bidOn sends one BidAuctionMessage with bid and maxProxy', () => {
    const { ctx, sent } = createFakeContext();
    ctx.bidOn(0xabc1n, 1500, 2500);
    expect(sent.length).toBe(1);
    const msg = sent[0] as BidAuctionMessage;
    expect(msg).toBeInstanceOf(BidAuctionMessage);
    expect(msg.itemId).toBe(0xabc1n);
    expect(msg.bid).toBe(1500);
    expect(msg.maxProxyBid).toBe(2500);
  });

  it('bidOn defaults maxProxy to the bid amount', () => {
    const { ctx, sent } = createFakeContext();
    ctx.bidOn(0xabc1n, 500);
    const msg = sent[0] as BidAuctionMessage;
    expect(msg.bid).toBe(500);
    expect(msg.maxProxyBid).toBe(500);
  });

  it('listForSale (bidding-style) sends CreateAuctionMessage and resolves with success', async () => {
    const { ctx, sent, simulateRecv } = createFakeContext();
    const terminalId = 0xabc1n;
    const itemId = 0x99n;
    const promise = ctx.listForSale(terminalId, itemId, {
      price: 1000,
      description: 'Cheap deal',
      localizedName: 'Plasma Rifle',
    });

    queueMicrotask(() => {
      simulateRecv(new CreateAuctionResponseMessage(itemId, AuctionResult.OK, ''));
    });

    const result = await promise;
    expect(result.success).toBe(true);
    expect(result.auctionId).toBe(itemId);
    expect(result.resultCode).toBe(AuctionResult.OK);
    expect(result.errorReason).toBeUndefined();

    expect(sent.length).toBe(1);
    const msg = sent[0] as CreateAuctionMessage;
    expect(msg).toBeInstanceOf(CreateAuctionMessage);
    expect(msg.itemId).toBe(itemId);
    expect(msg.containerId).toBe(terminalId);
    expect(msg.minimumBid).toBe(1000);
    expect(msg.userDescription).toBe('Cheap deal');
    expect(msg.itemLocalizedName).toBe('Plasma Rifle');
    expect(msg.auctionLength).toBe(24 * 3600);
    expect(msg.premium).toBe(false);
  });

  it('listForSale (instant) sends CreateImmediateAuctionMessage', async () => {
    const { ctx, sent, simulateRecv } = createFakeContext();
    const terminalId = 0xabc1n;
    const itemId = 0x99n;
    const promise = ctx.listForSale(terminalId, itemId, {
      price: 5000,
      durationHours: 12,
      instantSale: true,
      premium: true,
    });

    queueMicrotask(() => {
      simulateRecv(new CreateAuctionResponseMessage(itemId, AuctionResult.OK, ''));
    });

    const result = await promise;
    expect(result.success).toBe(true);

    const msg = sent[0] as CreateImmediateAuctionMessage;
    expect(msg).toBeInstanceOf(CreateImmediateAuctionMessage);
    expect(msg.itemId).toBe(itemId);
    expect(msg.containerId).toBe(terminalId);
    expect(msg.price).toBe(5000);
    expect(msg.auctionLength).toBe(12 * 3600);
    expect(msg.premium).toBe(true);
    expect(msg.vendorTransfer).toBe(false);
  });

  it('listForSale surfaces failure result and errorReason', async () => {
    const { ctx, simulateRecv } = createFakeContext();
    const itemId = 0x99n;
    const promise = ctx.listForSale(0xabc1n, itemId, { price: 100 });

    queueMicrotask(() => {
      simulateRecv(
        new CreateAuctionResponseMessage(itemId, AuctionResult.ITEM_RESTRICTED, 'no_trade flag'),
      );
    });

    const result = await promise;
    expect(result.success).toBe(false);
    expect(result.resultCode).toBe(AuctionResult.ITEM_RESTRICTED);
    expect(result.errorReason).toBe('no_trade flag');
    expect(result.auctionId).toBeUndefined();
  });

  it('retrieveBazaarItem sends one RetrieveAuctionItemMessage', () => {
    const { ctx, sent } = createFakeContext();
    ctx.retrieveBazaarItem(0xabc1n, 0x99n);
    expect(sent.length).toBe(1);
    const msg = sent[0] as RetrieveAuctionItemMessage;
    expect(msg).toBeInstanceOf(RetrieveAuctionItemMessage);
    expect(msg.itemId).toBe(0x99n);
    expect(msg.containerId).toBe(0xabc1n);
  });

  it('cancelMyListing sends one CancelLiveAuctionMessage', () => {
    const { ctx, sent } = createFakeContext();
    ctx.cancelMyListing(0xfeedn);
    expect(sent.length).toBe(1);
    const msg = sent[0] as CancelLiveAuctionMessage;
    expect(msg).toBeInstanceOf(CancelLiveAuctionMessage);
    expect(msg.itemId).toBe(0xfeedn);
  });

  it('all commodity sends count toward sendsCount', () => {
    const { ctx, sent } = createFakeContext();
    ctx.bidOn(0x1n, 100);
    ctx.cancelMyListing(0x2n);
    ctx.retrieveBazaarItem(0x10n, 0x3n);
    expect(sent.length).toBe(3);
  });
});
