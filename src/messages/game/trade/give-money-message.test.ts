import { describe, expect, it } from 'vitest';

import { encodeMessage, parseHeader } from '../../base.js';
import { messageRegistry } from '../../registry.js';
import { GiveMoneyMessage } from './give-money-message.js';

import './give-money-message.js';

describe('GiveMoneyMessage', () => {
  it('has the expected metadata', () => {
    expect(GiveMoneyMessage.messageName).toBe('GiveMoneyMessage');
    expect(GiveMoneyMessage.varCount).toBe(2);
    expect(GiveMoneyMessage.typeCrc).toBeGreaterThan(0);
  });

  it('round-trips a positive amount', () => {
    const original = new GiveMoneyMessage(123_456);
    const bytes = encodeMessage(original);

    const { typeCrc, payload } = parseHeader(bytes);
    expect(typeCrc).toBe(GiveMoneyMessage.typeCrc);
    const decoder = messageRegistry.getByCrc(typeCrc);
    if (!decoder) throw new Error('decoder not registered');
    const decoded = decoder.decodePayload(payload);
    expect(decoded).toBeInstanceOf(GiveMoneyMessage);
    if (!(decoded instanceof GiveMoneyMessage)) throw new Error('typeguard');
    expect(decoded.amount).toBe(123_456);
  });

  it('round-trips zero (no credits offered)', () => {
    const original = new GiveMoneyMessage(0);
    const bytes = encodeMessage(original);
    const { payload } = parseHeader(bytes);
    const decoded = GiveMoneyMessage.decodePayload(payload);
    expect(decoded.amount).toBe(0);
  });

  it('has the exact byte layout we expect', () => {
    const msg = new GiveMoneyMessage(1);
    const bytes = encodeMessage(msg);
    // Header: 6 bytes + payload (i32) = 4 → 10 total
    expect(bytes.length).toBe(10);
    expect(bytes[0]).toBe(0x02);
    expect(bytes[1]).toBe(0x00);
    // amount=1 at offset 6 (LE i32)
    expect(bytes[6]).toBe(0x01);
    expect(bytes[7]).toBe(0x00);
    expect(bytes[8]).toBe(0x00);
    expect(bytes[9]).toBe(0x00);
  });
});
