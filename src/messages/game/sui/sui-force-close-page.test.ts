import { describe, expect, it } from 'vitest';

import { encodeMessage, parseHeader } from '../../base.js';
import { messageRegistry } from '../../registry.js';
import { SuiForceClosePage } from './sui-force-close-page.js';

import './sui-force-close-page.js';

describe('SuiForceClosePage', () => {
  it('has the expected metadata', () => {
    expect(SuiForceClosePage.messageName).toBe('SuiForceClosePage');
    expect(SuiForceClosePage.varCount).toBe(2);
    expect(SuiForceClosePage.typeCrc).toBeGreaterThan(0);
  });

  it('round-trips encode → decode', () => {
    const original = new SuiForceClosePage(99);
    const bytes = encodeMessage(original);

    const { varCount, typeCrc, payload } = parseHeader(bytes);
    expect(varCount).toBe(2);
    expect(typeCrc).toBe(SuiForceClosePage.typeCrc);

    const decoder = messageRegistry.getByCrc(typeCrc);
    if (!decoder) throw new Error('decoder not registered');
    const decoded = decoder.decodePayload(payload);
    expect(decoded).toBeInstanceOf(SuiForceClosePage);
    if (!(decoded instanceof SuiForceClosePage)) throw new Error('typeguard');
    expect(decoded.clientPageId).toBe(99);
  });

  it('has the exact byte layout we expect', () => {
    const msg = new SuiForceClosePage(0x01020304);
    const bytes = encodeMessage(msg);
    // varCount=2 (u16 LE) + typeCrc (u32 LE) + clientPageId (i32 LE) = 10 bytes
    expect(bytes.length).toBe(10);
    expect(bytes[0]).toBe(0x02);
    expect(bytes[1]).toBe(0x00);
    // clientPageId 0x01020304 LE → 04 03 02 01 at offset 6
    expect(bytes[6]).toBe(0x04);
    expect(bytes[7]).toBe(0x03);
    expect(bytes[8]).toBe(0x02);
    expect(bytes[9]).toBe(0x01);
  });

  it('accepts a -1 clientPageId (matches C++ SUIMessage default)', () => {
    const original = new SuiForceClosePage(-1);
    const bytes = encodeMessage(original);
    const { payload } = parseHeader(bytes);
    const decoded = SuiForceClosePage.decodePayload(payload);
    expect(decoded.clientPageId).toBe(-1);
  });
});
