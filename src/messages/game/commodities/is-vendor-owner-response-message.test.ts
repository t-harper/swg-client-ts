import { describe, expect, it } from 'vitest';

import { encodeMessage, parseHeader } from '../../base.js';
import { AuctionResult, VendorOwnerResult } from './auction-error-codes.js';
import { IsVendorOwnerResponseMessage } from './is-vendor-owner-response-message.js';

import './is-vendor-owner-response-message.js';

describe('IsVendorOwnerResponseMessage', () => {
  it('has the expected metadata', () => {
    expect(IsVendorOwnerResponseMessage.messageName).toBe('IsVendorOwnerResponseMessage');
    expect(IsVendorOwnerResponseMessage.varCount).toBe(6);
    expect(IsVendorOwnerResponseMessage.typeCrc).toBeGreaterThan(0);
  });

  it('round-trips encode → decode', () => {
    const msg = new IsVendorOwnerResponseMessage(
      VendorOwnerResult.IsOwner,
      AuctionResult.OK,
      0xdeadn,
      'Mos Eisley Bazaar',
      100,
    );
    const bytes = encodeMessage(msg);
    const { payload } = parseHeader(bytes);
    const decoded = IsVendorOwnerResponseMessage.decodePayload(payload);
    expect(decoded.ownerResult).toBe(VendorOwnerResult.IsOwner);
    expect(decoded.result).toBe(AuctionResult.OK);
    expect(decoded.containerId).toBe(0xdeadn);
    expect(decoded.marketName).toBe('Mos Eisley Bazaar');
    expect(decoded.maxPageSize).toBe(100);
  });

  it('round-trips non-owner with empty market name', () => {
    const msg = new IsVendorOwnerResponseMessage(
      VendorOwnerResult.IsNotOwner,
      AuctionResult.OK,
      0n,
      '',
      0,
    );
    const bytes = encodeMessage(msg);
    const { payload } = parseHeader(bytes);
    const decoded = IsVendorOwnerResponseMessage.decodePayload(payload);
    expect(decoded.ownerResult).toBe(VendorOwnerResult.IsNotOwner);
    expect(decoded.marketName).toBe('');
    expect(decoded.maxPageSize).toBe(0);
  });
});
