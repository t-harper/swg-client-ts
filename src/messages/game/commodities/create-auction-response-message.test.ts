import { describe, expect, it } from 'vitest';

import { encodeMessage, parseHeader } from '../../base.js';
import { AuctionResult } from './auction-error-codes.js';
import { CreateAuctionResponseMessage } from './create-auction-response-message.js';

import './create-auction-response-message.js';

describe('CreateAuctionResponseMessage', () => {
  it('has the expected metadata', () => {
    expect(CreateAuctionResponseMessage.messageName).toBe('CreateAuctionResponseMessage');
    expect(CreateAuctionResponseMessage.varCount).toBe(4);
    expect(CreateAuctionResponseMessage.typeCrc).toBeGreaterThan(0);
  });

  it('round-trips encode → decode (OK / empty rejection)', () => {
    const msg = new CreateAuctionResponseMessage(0x1n, AuctionResult.OK, '');
    const bytes = encodeMessage(msg);
    const { payload } = parseHeader(bytes);
    const decoded = CreateAuctionResponseMessage.decodePayload(payload);
    expect(decoded.itemId).toBe(0x1n);
    expect(decoded.result).toBe(AuctionResult.OK);
    expect(decoded.itemRestrictedRejectionMessage).toBe('');
  });

  it('round-trips ITEM_RESTRICTED with explanation string', () => {
    const msg = new CreateAuctionResponseMessage(
      0x99n,
      AuctionResult.ITEM_RESTRICTED,
      'no_trade flag is set',
    );
    const bytes = encodeMessage(msg);
    const { payload } = parseHeader(bytes);
    const decoded = CreateAuctionResponseMessage.decodePayload(payload);
    expect(decoded.result).toBe(AuctionResult.ITEM_RESTRICTED);
    expect(decoded.itemRestrictedRejectionMessage).toBe('no_trade flag is set');
  });
});
