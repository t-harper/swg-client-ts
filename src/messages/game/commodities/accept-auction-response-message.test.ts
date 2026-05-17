import { describe, expect, it } from 'vitest';

import { encodeMessage, parseHeader } from '../../base.js';
import { AcceptAuctionResponseMessage } from './accept-auction-response-message.js';
import { AuctionResult } from './auction-error-codes.js';

import './accept-auction-response-message.js';

describe('AcceptAuctionResponseMessage', () => {
  it('has the expected metadata', () => {
    expect(AcceptAuctionResponseMessage.messageName).toBe('AcceptAuctionResponseMessage');
    expect(AcceptAuctionResponseMessage.varCount).toBe(3);
    expect(AcceptAuctionResponseMessage.typeCrc).toBeGreaterThan(0);
  });

  it('round-trips encode → decode', () => {
    const msg = new AcceptAuctionResponseMessage(0xabc1n, AuctionResult.OK);
    const bytes = encodeMessage(msg);
    const { payload } = parseHeader(bytes);
    const decoded = AcceptAuctionResponseMessage.decodePayload(payload);
    expect(decoded.itemId).toBe(0xabc1n);
    expect(decoded.result).toBe(AuctionResult.OK);
  });
});
