import { describe, expect, it } from 'vitest';

import { encodeMessage, parseHeader } from '../../base.js';
import { CreateAuctionMessage } from './create-auction-message.js';

import './create-auction-message.js';

describe('CreateAuctionMessage', () => {
  it('has the expected metadata', () => {
    expect(CreateAuctionMessage.messageName).toBe('CreateAuctionMessage');
    expect(CreateAuctionMessage.varCount).toBe(8);
    expect(CreateAuctionMessage.typeCrc).toBeGreaterThan(0);
  });

  it('round-trips encode → decode', () => {
    const msg = new CreateAuctionMessage(
      0xabc1n,
      'Plasma Rifle',
      0x4321n,
      1000,
      3600 * 24,
      'Lightly used, mint condition.',
      false,
    );
    const bytes = encodeMessage(msg);
    const { payload } = parseHeader(bytes);
    const decoded = CreateAuctionMessage.decodePayload(payload);
    expect(decoded.itemId).toBe(0xabc1n);
    expect(decoded.itemLocalizedName).toBe('Plasma Rifle');
    expect(decoded.containerId).toBe(0x4321n);
    expect(decoded.minimumBid).toBe(1000);
    expect(decoded.auctionLength).toBe(3600 * 24);
    expect(decoded.userDescription).toBe('Lightly used, mint condition.');
    expect(decoded.premium).toBe(false);
  });

  it('round-trips premium auction with empty strings', () => {
    const msg = new CreateAuctionMessage(0x1n, '', 0x2n, 50, 120, '', true);
    const bytes = encodeMessage(msg);
    const { payload } = parseHeader(bytes);
    const decoded = CreateAuctionMessage.decodePayload(payload);
    expect(decoded.premium).toBe(true);
    expect(decoded.itemLocalizedName).toBe('');
    expect(decoded.userDescription).toBe('');
  });
});
