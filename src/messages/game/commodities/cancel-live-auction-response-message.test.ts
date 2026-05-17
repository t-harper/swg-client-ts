import { describe, expect, it } from 'vitest';

import { encodeMessage, parseHeader } from '../../base.js';
import { AuctionResult } from './auction-error-codes.js';
import { CancelLiveAuctionResponseMessage } from './cancel-live-auction-response-message.js';

import './cancel-live-auction-response-message.js';

describe('CancelLiveAuctionResponseMessage', () => {
  it('has the expected metadata', () => {
    expect(CancelLiveAuctionResponseMessage.messageName).toBe('CancelLiveAuctionResponseMessage');
    expect(CancelLiveAuctionResponseMessage.varCount).toBe(4);
    expect(CancelLiveAuctionResponseMessage.typeCrc).toBeGreaterThan(0);
  });

  it('round-trips encode → decode (vendor refusal false)', () => {
    const msg = new CancelLiveAuctionResponseMessage(0x1n, AuctionResult.OK, false);
    const bytes = encodeMessage(msg);
    const { payload } = parseHeader(bytes);
    const decoded = CancelLiveAuctionResponseMessage.decodePayload(payload);
    expect(decoded.itemId).toBe(0x1n);
    expect(decoded.result).toBe(AuctionResult.OK);
    expect(decoded.vendorRefusal).toBe(false);
  });

  it('round-trips with vendor refusal true', () => {
    const msg = new CancelLiveAuctionResponseMessage(0x99n, AuctionResult.NOT_ALLOWED, true);
    const bytes = encodeMessage(msg);
    const { payload } = parseHeader(bytes);
    const decoded = CancelLiveAuctionResponseMessage.decodePayload(payload);
    expect(decoded.vendorRefusal).toBe(true);
    expect(decoded.result).toBe(AuctionResult.NOT_ALLOWED);
  });

  it('has the exact byte layout', () => {
    const bytes = encodeMessage(new CancelLiveAuctionResponseMessage(0x1n, AuctionResult.OK, true));
    // Header (6) + NetworkId (8) + i32 (4) + bool (1) = 19
    expect(bytes.length).toBe(19);
    expect(bytes[0]).toBe(0x04);
    expect(bytes[18]).toBe(0x01); // vendorRefusal = true
  });
});
