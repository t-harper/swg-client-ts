import { describe, expect, it } from 'vitest';

import { encodeMessage, parseHeader } from '../../base.js';
import { AuctionResult } from './auction-error-codes.js';
import { RetrieveAuctionItemResponseMessage } from './retrieve-auction-item-response-message.js';

import './retrieve-auction-item-response-message.js';

describe('RetrieveAuctionItemResponseMessage', () => {
  it('has the expected metadata', () => {
    expect(RetrieveAuctionItemResponseMessage.messageName).toBe(
      'RetrieveAuctionItemResponseMessage',
    );
    expect(RetrieveAuctionItemResponseMessage.varCount).toBe(3);
    expect(RetrieveAuctionItemResponseMessage.typeCrc).toBeGreaterThan(0);
  });

  it('round-trips encode → decode', () => {
    const msg = new RetrieveAuctionItemResponseMessage(0x1n, AuctionResult.OK);
    const bytes = encodeMessage(msg);
    const { payload } = parseHeader(bytes);
    const decoded = RetrieveAuctionItemResponseMessage.decodePayload(payload);
    expect(decoded.itemId).toBe(0x1n);
    expect(decoded.result).toBe(AuctionResult.OK);
  });

  it('round-trips a failure result', () => {
    const msg = new RetrieveAuctionItemResponseMessage(0x99n, AuctionResult.INVENTORY_FULL);
    const bytes = encodeMessage(msg);
    const { payload } = parseHeader(bytes);
    const decoded = RetrieveAuctionItemResponseMessage.decodePayload(payload);
    expect(decoded.result).toBe(AuctionResult.INVENTORY_FULL);
  });
});
