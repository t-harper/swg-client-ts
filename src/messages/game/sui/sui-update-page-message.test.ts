import { describe, expect, it } from 'vitest';

import { encodeMessage, parseHeader } from '../../base.js';
import { messageRegistry } from '../../registry.js';
import { SuiUpdatePageMessage } from './sui-update-page-message.js';

import './sui-update-page-message.js';

describe('SuiUpdatePageMessage', () => {
  it('has the expected metadata', () => {
    expect(SuiUpdatePageMessage.messageName).toBe('SuiUpdatePageMessage');
    expect(SuiUpdatePageMessage.varCount).toBe(2);
    expect(SuiUpdatePageMessage.typeCrc).toBeGreaterThan(0);
  });

  it('round-trips encode → decode preserving opaque payload', () => {
    const payload = new Uint8Array([0x2a, 0x00, 0x00, 0x00, 0xfe, 0xed]);
    const original = new SuiUpdatePageMessage(payload);
    const bytes = encodeMessage(original);

    const { varCount, typeCrc, payload: iter } = parseHeader(bytes);
    expect(varCount).toBe(2);
    expect(typeCrc).toBe(SuiUpdatePageMessage.typeCrc);

    const decoder = messageRegistry.getByCrc(typeCrc);
    if (!decoder) throw new Error('decoder not registered');
    const decoded = decoder.decodePayload(iter);
    expect(decoded).toBeInstanceOf(SuiUpdatePageMessage);
    if (!(decoded instanceof SuiUpdatePageMessage)) throw new Error('typeguard');
    expect(Array.from(decoded.pageData)).toEqual(Array.from(payload));
  });

  it('extracts the leading pageId from the opaque payload', () => {
    // pageId = 42 LE
    const msg = new SuiUpdatePageMessage(new Uint8Array([0x2a, 0x00, 0x00, 0x00]));
    expect(msg.pageId).toBe(42);
  });
});
