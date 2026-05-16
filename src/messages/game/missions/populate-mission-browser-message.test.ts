import { describe, expect, it } from 'vitest';

import { encodeMessage, parseHeader } from '../../base.js';
import { messageRegistry } from '../../registry.js';
import { PopulateMissionBrowserMessage } from './populate-mission-browser-message.js';

// Side-effect import (registers decoder)
import './populate-mission-browser-message.js';

describe('PopulateMissionBrowserMessage', () => {
  it('has the expected metadata', () => {
    expect(PopulateMissionBrowserMessage.messageName).toBe('PopulateMissionBrowserMessage');
    expect(PopulateMissionBrowserMessage.varCount).toBe(2);
    expect(PopulateMissionBrowserMessage.typeCrc).toBeGreaterThan(0);
  });

  it('round-trips an empty mission list (terminal has no missions yet)', () => {
    const original = new PopulateMissionBrowserMessage([]);
    const bytes = encodeMessage(original);

    const { varCount, typeCrc, payload } = parseHeader(bytes);
    expect(varCount).toBe(2);
    expect(typeCrc).toBe(PopulateMissionBrowserMessage.typeCrc);

    const decoder = messageRegistry.getByCrc(typeCrc);
    if (!decoder) throw new Error('decoder missing');
    const decoded = decoder.decodePayload(payload);
    expect(decoded).toBeInstanceOf(PopulateMissionBrowserMessage);
    if (!(decoded instanceof PopulateMissionBrowserMessage)) throw new Error('typeguard');
    expect(decoded.missions).toEqual([]);
  });

  it('round-trips a realistic mission list (5 missions)', () => {
    const original = new PopulateMissionBrowserMessage([
      0x1111_1111_1111_1111n,
      0x2222_2222_2222_2222n,
      0x3333_3333_3333_3333n,
      0x4444_4444_4444_4444n,
      0x5555_5555_5555_5555n,
    ]);
    const bytes = encodeMessage(original);
    const { payload } = parseHeader(bytes);
    const decoded = PopulateMissionBrowserMessage.decodePayload(payload);
    expect(decoded.missions).toHaveLength(5);
    expect(decoded.missions[0]).toBe(0x1111_1111_1111_1111n);
    expect(decoded.missions[4]).toBe(0x5555_5555_5555_5555n);
  });

  it('handles signed NetworkIds (negative values round-trip)', () => {
    const original = new PopulateMissionBrowserMessage([-1n, -2n, 0x7fff_ffff_ffff_ffffn]);
    const bytes = encodeMessage(original);
    const { payload } = parseHeader(bytes);
    const decoded = PopulateMissionBrowserMessage.decodePayload(payload);
    expect(decoded.missions[0]).toBe(-1n);
    expect(decoded.missions[1]).toBe(-2n);
    expect(decoded.missions[2]).toBe(0x7fff_ffff_ffff_ffffn);
  });

  it('has the exact byte layout we expect (one mission)', () => {
    const msg = new PopulateMissionBrowserMessage([1n]);
    const bytes = encodeMessage(msg);
    // Header: varCount=2 (u16 LE) + typeCrc (u32 LE) = 6 bytes
    // Payload: u32 count=1 + i64 NetworkId = 4 + 8 = 12 bytes
    // Total = 18 bytes
    expect(bytes.length).toBe(18);
    // varCount = 2 LE
    expect(bytes[0]).toBe(0x02);
    expect(bytes[1]).toBe(0x00);
    // count = 1 LE at offset 6
    expect(bytes[6]).toBe(0x01);
    expect(bytes[7]).toBe(0x00);
    expect(bytes[8]).toBe(0x00);
    expect(bytes[9]).toBe(0x00);
    // NetworkId = 1 LE at offset 10
    expect(bytes[10]).toBe(0x01);
    for (let i = 11; i < 18; i++) {
      expect(bytes[i]).toBe(0x00);
    }
  });
});
