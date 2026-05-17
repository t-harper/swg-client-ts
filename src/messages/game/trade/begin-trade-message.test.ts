import { describe, expect, it } from 'vitest';

import { encodeMessage, parseHeader } from '../../base.js';
import { messageRegistry } from '../../registry.js';
import { BeginTradeMessage } from './begin-trade-message.js';

import './begin-trade-message.js';

describe('BeginTradeMessage', () => {
  it('has the expected metadata', () => {
    expect(BeginTradeMessage.messageName).toBe('BeginTradeMessage');
    expect(BeginTradeMessage.varCount).toBe(2);
    expect(BeginTradeMessage.typeCrc).toBeGreaterThan(0);
  });

  it('round-trips encode -> decode', () => {
    const original = new BeginTradeMessage(0x1234_5678_9abc_def0n);
    const bytes = encodeMessage(original);

    const { varCount, typeCrc, payload } = parseHeader(bytes);
    expect(varCount).toBe(2);
    expect(typeCrc).toBe(BeginTradeMessage.typeCrc);

    const decoder = messageRegistry.getByCrc(typeCrc);
    if (!decoder) throw new Error('decoder not registered');
    const decoded = decoder.decodePayload(payload);
    expect(decoded).toBeInstanceOf(BeginTradeMessage);
    if (!(decoded instanceof BeginTradeMessage)) throw new Error('typeguard');
    expect(decoded.player).toBe(0x1234_5678_9abc_def0n);
  });

  it('handles signed NetworkIds (negative values round-trip)', () => {
    const original = new BeginTradeMessage(-1n);
    const bytes = encodeMessage(original);
    const { payload } = parseHeader(bytes);
    const decoded = BeginTradeMessage.decodePayload(payload);
    expect(decoded.player).toBe(-1n);
  });

  it('has the exact byte layout we expect', () => {
    const msg = new BeginTradeMessage(1n);
    const bytes = encodeMessage(msg);
    // Header: varCount=2 (u16 LE) + typeCrc (u32 LE) = 6 bytes
    // Payload: NetworkId (i64 LE) = 8 bytes
    // Total = 14 bytes
    expect(bytes.length).toBe(14);
    expect(bytes[0]).toBe(0x02);
    expect(bytes[1]).toBe(0x00);
    // NetworkId = 1 LE at offset 6
    expect(bytes[6]).toBe(0x01);
    for (let i = 7; i < 14; i++) {
      expect(bytes[i]).toBe(0x00);
    }
  });
});
