import { describe, expect, it } from 'vitest';

import { encodeMessage, parseHeader } from '../../base.js';
import { IsVendorOwnerMessage } from './is-vendor-owner-message.js';

import './is-vendor-owner-message.js';

describe('IsVendorOwnerMessage', () => {
  it('has the expected metadata', () => {
    expect(IsVendorOwnerMessage.messageName).toBe('IsVendorOwnerMessage');
    expect(IsVendorOwnerMessage.varCount).toBe(2);
    expect(IsVendorOwnerMessage.typeCrc).toBeGreaterThan(0);
  });

  it('round-trips encode → decode', () => {
    const msg = new IsVendorOwnerMessage(0xabcdn);
    const bytes = encodeMessage(msg);
    const { payload } = parseHeader(bytes);
    const decoded = IsVendorOwnerMessage.decodePayload(payload);
    expect(decoded.containerId).toBe(0xabcdn);
  });
});
