import { describe, expect, it } from 'vitest';

import { encodeMessage, parseHeader } from '../../base.js';
import { messageRegistry } from '../../registry.js';
import { RemoveItemMessage } from './remove-item-message.js';

import './remove-item-message.js';

describe('RemoveItemMessage', () => {
  it('has the expected metadata', () => {
    expect(RemoveItemMessage.messageName).toBe('RemoveItemMessage');
    expect(RemoveItemMessage.varCount).toBe(2);
    expect(RemoveItemMessage.typeCrc).toBeGreaterThan(0);
  });

  it('round-trips encode -> decode', () => {
    const original = new RemoveItemMessage(0x1234n);
    const bytes = encodeMessage(original);
    const { payload } = parseHeader(bytes);
    const decoded = RemoveItemMessage.decodePayload(payload);
    expect(decoded.object).toBe(0x1234n);
  });

  it('has the exact byte layout we expect', () => {
    const msg = new RemoveItemMessage(2n);
    const bytes = encodeMessage(msg);
    expect(bytes.length).toBe(14);
    expect(bytes[0]).toBe(0x02);
    expect(bytes[6]).toBe(0x02);
  });
});
