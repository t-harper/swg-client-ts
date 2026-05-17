import { describe, expect, it } from 'vitest';

import { encodeMessage, parseHeader } from '../../base.js';
import { CreateImmediateAuctionMessage } from './create-immediate-auction-message.js';

import './create-immediate-auction-message.js';

describe('CreateImmediateAuctionMessage', () => {
  it('has the expected metadata', () => {
    expect(CreateImmediateAuctionMessage.messageName).toBe('CreateImmediateAuctionMessage');
    expect(CreateImmediateAuctionMessage.varCount).toBe(9);
    expect(CreateImmediateAuctionMessage.typeCrc).toBeGreaterThan(0);
  });

  it('round-trips encode → decode', () => {
    const msg = new CreateImmediateAuctionMessage(
      0xabc1n,
      'Krayt Tissue',
      0x4321n,
      5000,
      3600,
      'Fresh from the dune sea',
      true,
      false,
    );
    const bytes = encodeMessage(msg);
    const { payload } = parseHeader(bytes);
    const decoded = CreateImmediateAuctionMessage.decodePayload(payload);
    expect(decoded.itemId).toBe(0xabc1n);
    expect(decoded.itemLocalizedName).toBe('Krayt Tissue');
    expect(decoded.containerId).toBe(0x4321n);
    expect(decoded.price).toBe(5000);
    expect(decoded.auctionLength).toBe(3600);
    expect(decoded.userDescription).toBe('Fresh from the dune sea');
    expect(decoded.premium).toBe(true);
    expect(decoded.vendorTransfer).toBe(false);
  });

  it('round-trips a vendor-transfer flagged listing', () => {
    const msg = new CreateImmediateAuctionMessage(0x1n, '', 0x2n, 100, 60, '', false, true);
    const bytes = encodeMessage(msg);
    const { payload } = parseHeader(bytes);
    const decoded = CreateImmediateAuctionMessage.decodePayload(payload);
    expect(decoded.vendorTransfer).toBe(true);
    expect(decoded.premium).toBe(false);
  });
});
