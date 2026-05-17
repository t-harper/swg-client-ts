import { describe, expect, it } from 'vitest';

import { encodeMessage, parseHeader } from '../../base.js';
import { AcceptAuctionMessage } from './accept-auction-message.js';

import './accept-auction-message.js';

describe('AcceptAuctionMessage', () => {
  it('has the expected metadata', () => {
    expect(AcceptAuctionMessage.messageName).toBe('AcceptAuctionMessage');
    expect(AcceptAuctionMessage.varCount).toBe(2);
    expect(AcceptAuctionMessage.typeCrc).toBeGreaterThan(0);
  });

  it('round-trips encode → decode', () => {
    const msg = new AcceptAuctionMessage(0x123n);
    const bytes = encodeMessage(msg);
    const { payload } = parseHeader(bytes);
    const decoded = AcceptAuctionMessage.decodePayload(payload);
    expect(decoded.itemId).toBe(0x123n);
  });

  it('has the exact byte layout', () => {
    const bytes = encodeMessage(new AcceptAuctionMessage(0x1n));
    expect(bytes.length).toBe(14);
    expect(bytes[0]).toBe(0x02);
    expect(bytes[6]).toBe(0x01);
  });
});
