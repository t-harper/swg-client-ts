import { describe, expect, it } from 'vitest';

import { encodeMessage, parseHeader } from '../../base.js';
import { RetrieveAuctionItemMessage } from './retrieve-auction-item-message.js';

import './retrieve-auction-item-message.js';

describe('RetrieveAuctionItemMessage', () => {
  it('has the expected metadata', () => {
    expect(RetrieveAuctionItemMessage.messageName).toBe('RetrieveAuctionItemMessage');
    expect(RetrieveAuctionItemMessage.varCount).toBe(3);
    expect(RetrieveAuctionItemMessage.typeCrc).toBeGreaterThan(0);
  });

  it('round-trips encode → decode', () => {
    const msg = new RetrieveAuctionItemMessage(0xabc1n, 0x4321n);
    const bytes = encodeMessage(msg);
    const { payload } = parseHeader(bytes);
    const decoded = RetrieveAuctionItemMessage.decodePayload(payload);
    expect(decoded.itemId).toBe(0xabc1n);
    expect(decoded.containerId).toBe(0x4321n);
  });

  it('has the exact byte layout', () => {
    const bytes = encodeMessage(new RetrieveAuctionItemMessage(0x1n, 0x2n));
    // Header (6) + NetworkId (8) + NetworkId (8) = 22
    expect(bytes.length).toBe(22);
    expect(bytes[0]).toBe(0x03);
    expect(bytes[6]).toBe(0x01); // itemId
    expect(bytes[14]).toBe(0x02); // containerId
  });
});
