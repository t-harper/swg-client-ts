import { describe, expect, it } from 'vitest';

import { encodeMessage, parseHeader } from '../../base.js';
import { messageRegistry } from '../../registry.js';
import { BidAuctionMessage } from './bid-auction-message.js';

import './bid-auction-message.js';

describe('BidAuctionMessage', () => {
  it('has the expected metadata', () => {
    expect(BidAuctionMessage.messageName).toBe('BidAuctionMessage');
    expect(BidAuctionMessage.varCount).toBe(4);
    expect(BidAuctionMessage.typeCrc).toBeGreaterThan(0);
  });

  it('round-trips encode → decode', () => {
    const original = new BidAuctionMessage(0xdeadbeefn, 1500, 2500);
    const bytes = encodeMessage(original);

    const { varCount, typeCrc, payload } = parseHeader(bytes);
    expect(varCount).toBe(4);
    expect(typeCrc).toBe(BidAuctionMessage.typeCrc);

    const decoder = messageRegistry.getByCrc(typeCrc);
    if (!decoder) throw new Error('decoder missing');
    const decoded = decoder.decodePayload(payload);
    expect(decoded).toBeInstanceOf(BidAuctionMessage);
    if (!(decoded instanceof BidAuctionMessage)) throw new Error('typeguard');
    expect(decoded.itemId).toBe(0xdeadbeefn);
    expect(decoded.bid).toBe(1500);
    expect(decoded.maxProxyBid).toBe(2500);
  });

  it('has the exact byte layout we expect', () => {
    const msg = new BidAuctionMessage(1n, 100, 200);
    const bytes = encodeMessage(msg);
    // Header: varCount=4 (u16) + typeCrc (u32) = 6
    // Payload: NetworkId(8) + i32(4) + i32(4) = 16
    expect(bytes.length).toBe(22);
    expect(bytes[0]).toBe(0x04);
    expect(bytes[1]).toBe(0x00);
    // itemId LSB at offset 6
    expect(bytes[6]).toBe(0x01);
    for (let i = 7; i < 14; i++) expect(bytes[i]).toBe(0x00);
    // bid = 100 (0x64) at offset 14
    expect(bytes[14]).toBe(0x64);
    // maxProxyBid = 200 (0xc8) at offset 18
    expect(bytes[18]).toBe(0xc8);
  });
});
