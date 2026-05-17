import { describe, expect, it } from 'vitest';

import { encodeMessage, parseHeader } from '../../base.js';
import { GetAuctionDetails } from './get-auction-details.js';

import './get-auction-details.js';

describe('GetAuctionDetails', () => {
  it('has the expected metadata', () => {
    expect(GetAuctionDetails.messageName).toBe('GetAuctionDetails');
    expect(GetAuctionDetails.varCount).toBe(2);
    expect(GetAuctionDetails.typeCrc).toBeGreaterThan(0);
  });

  it('round-trips encode → decode', () => {
    const msg = new GetAuctionDetails(0xdeadbeefn);
    const bytes = encodeMessage(msg);
    const { payload } = parseHeader(bytes);
    const decoded = GetAuctionDetails.decodePayload(payload);
    expect(decoded.itemId).toBe(0xdeadbeefn);
  });
});
