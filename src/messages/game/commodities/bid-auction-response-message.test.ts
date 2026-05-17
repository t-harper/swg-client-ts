import { describe, expect, it } from 'vitest';

import { encodeMessage, parseHeader } from '../../base.js';
import { messageRegistry } from '../../registry.js';
import { AuctionResult } from './auction-error-codes.js';
import { BidAuctionResponseMessage } from './bid-auction-response-message.js';

import './bid-auction-response-message.js';

describe('BidAuctionResponseMessage', () => {
  it('has the expected metadata', () => {
    expect(BidAuctionResponseMessage.messageName).toBe('BidAuctionResponseMessage');
    expect(BidAuctionResponseMessage.varCount).toBe(3);
    expect(BidAuctionResponseMessage.typeCrc).toBeGreaterThan(0);
  });

  it('round-trips encode → decode with OK result', () => {
    const original = new BidAuctionResponseMessage(0xfeedn, AuctionResult.OK);
    const bytes = encodeMessage(original);

    const { typeCrc, payload } = parseHeader(bytes);
    const decoder = messageRegistry.getByCrc(typeCrc);
    if (!decoder) throw new Error('decoder missing');
    const decoded = decoder.decodePayload(payload);
    expect(decoded).toBeInstanceOf(BidAuctionResponseMessage);
    if (!(decoded instanceof BidAuctionResponseMessage)) throw new Error('typeguard');
    expect(decoded.itemId).toBe(0xfeedn);
    expect(decoded.result).toBe(AuctionResult.OK);
  });

  it('round-trips a non-OK result', () => {
    const original = new BidAuctionResponseMessage(0x1n, AuctionResult.BID_OUTBID);
    const bytes = encodeMessage(original);
    const { payload } = parseHeader(bytes);
    const decoded = BidAuctionResponseMessage.decodePayload(payload);
    expect(decoded.result).toBe(AuctionResult.BID_OUTBID);
  });

  it('has the exact byte layout', () => {
    const msg = new BidAuctionResponseMessage(2n, AuctionResult.NOT_ENOUGH_MONEY);
    const bytes = encodeMessage(msg);
    // Header (6) + NetworkId (8) + i32 (4) = 18
    expect(bytes.length).toBe(18);
    expect(bytes[0]).toBe(0x03); // varCount
    expect(bytes[6]).toBe(0x02); // itemId LSB
    expect(bytes[14]).toBe(AuctionResult.NOT_ENOUGH_MONEY); // result LSB
  });
});
