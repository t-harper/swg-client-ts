import { describe, expect, it } from 'vitest';

import { encodeMessage, parseHeader } from '../../base.js';
import { CancelLiveAuctionMessage } from './cancel-live-auction-message.js';

import './cancel-live-auction-message.js';

describe('CancelLiveAuctionMessage', () => {
  it('has the expected metadata', () => {
    expect(CancelLiveAuctionMessage.messageName).toBe('CancelLiveAuctionMessage');
    expect(CancelLiveAuctionMessage.varCount).toBe(2);
    expect(CancelLiveAuctionMessage.typeCrc).toBeGreaterThan(0);
  });

  it('round-trips encode → decode', () => {
    const msg = new CancelLiveAuctionMessage(0x42n);
    const bytes = encodeMessage(msg);
    const { payload } = parseHeader(bytes);
    const decoded = CancelLiveAuctionMessage.decodePayload(payload);
    expect(decoded.itemId).toBe(0x42n);
  });

  it('has the exact byte layout', () => {
    const bytes = encodeMessage(new CancelLiveAuctionMessage(0x1n));
    // Header (6) + NetworkId (8) = 14
    expect(bytes.length).toBe(14);
    expect(bytes[0]).toBe(0x02); // varCount
    expect(bytes[6]).toBe(0x01); // itemId LSB
  });
});
