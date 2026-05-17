import { describe, expect, it } from 'vitest';

import { encodeMessage, parseHeader } from '../../base.js';
import { messageRegistry } from '../../registry.js';
import { AddItemMessage } from './add-item-message.js';

import './add-item-message.js';

describe('AddItemMessage', () => {
  it('has the expected metadata', () => {
    expect(AddItemMessage.messageName).toBe('AddItemMessage');
    expect(AddItemMessage.varCount).toBe(2);
    expect(AddItemMessage.typeCrc).toBeGreaterThan(0);
  });

  it('round-trips encode -> decode', () => {
    const original = new AddItemMessage(0xdead_beefn);
    const bytes = encodeMessage(original);

    const { varCount, typeCrc, payload } = parseHeader(bytes);
    expect(varCount).toBe(2);
    expect(typeCrc).toBe(AddItemMessage.typeCrc);

    const decoder = messageRegistry.getByCrc(typeCrc);
    if (!decoder) throw new Error('decoder not registered');
    const decoded = decoder.decodePayload(payload);
    expect(decoded).toBeInstanceOf(AddItemMessage);
    if (!(decoded instanceof AddItemMessage)) throw new Error('typeguard');
    expect(decoded.object).toBe(0xdead_beefn);
  });

  it('has the exact byte layout we expect', () => {
    const msg = new AddItemMessage(0xffn);
    const bytes = encodeMessage(msg);
    expect(bytes.length).toBe(14);
    expect(bytes[0]).toBe(0x02);
    expect(bytes[1]).toBe(0x00);
    expect(bytes[6]).toBe(0xff);
    for (let i = 7; i < 14; i++) {
      expect(bytes[i]).toBe(0x00);
    }
  });
});
