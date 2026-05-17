import { describe, expect, it } from 'vitest';

import { encodeMessage, parseHeader } from '../../base.js';
import { messageRegistry } from '../../registry.js';
import { SuiEventNotification } from './sui-event-notification.js';

import './sui-event-notification.js';

describe('SuiEventNotification', () => {
  it('has the expected metadata', () => {
    expect(SuiEventNotification.messageName).toBe('SuiEventNotification');
    expect(SuiEventNotification.varCount).toBe(4);
    expect(SuiEventNotification.typeCrc).toBeGreaterThan(0);
  });

  it('round-trips encode → decode with empty returnList', () => {
    const original = new SuiEventNotification(7, 3, []);
    const bytes = encodeMessage(original);

    const { varCount, typeCrc, payload } = parseHeader(bytes);
    expect(varCount).toBe(4);
    expect(typeCrc).toBe(SuiEventNotification.typeCrc);

    const decoder = messageRegistry.getByCrc(typeCrc);
    if (!decoder) throw new Error('decoder not registered');
    const decoded = decoder.decodePayload(payload);
    expect(decoded).toBeInstanceOf(SuiEventNotification);
    if (!(decoded instanceof SuiEventNotification)) throw new Error('typeguard');
    expect(decoded.pageId).toBe(7);
    expect(decoded.subscribedEventIndex).toBe(3);
    expect(decoded.returnList).toEqual([]);
  });

  it('round-trips encode → decode with multiple Unicode strings', () => {
    const original = new SuiEventNotification(42, 1, ['ok', 'cancel', 'star ★']);
    const bytes = encodeMessage(original);
    const { payload } = parseHeader(bytes);
    const decoded = SuiEventNotification.decodePayload(payload);
    expect(decoded.pageId).toBe(42);
    expect(decoded.subscribedEventIndex).toBe(1);
    expect(decoded.returnList).toEqual(['ok', 'cancel', 'star ★']);
  });

  it('has the exact byte layout we expect', () => {
    // pageId=7, eventIndex=3, returnList=['a']
    const msg = new SuiEventNotification(7, 3, ['a']);
    const bytes = encodeMessage(msg);
    // Header: varCount=4 (u16 LE) + typeCrc (u32 LE) = 6 bytes
    // pageId (i32 LE) = 4 bytes
    // subscribedEventIndex (i32 LE) = 4 bytes
    // returnList: u32 size=1 + u32 baselineCommandCount=0 = 8 bytes
    // Unicode 'a': u32 char-count=1 + 2 UTF-16 LE bytes = 6 bytes
    // Total = 6 + 4 + 4 + 8 + 6 = 28
    expect(bytes.length).toBe(28);
    expect(bytes[0]).toBe(0x04);
    expect(bytes[1]).toBe(0x00);
    // pageId=7 LE at offset 6
    expect(bytes[6]).toBe(0x07);
    expect(bytes[7]).toBe(0x00);
    // subscribedEventIndex=3 LE at offset 10
    expect(bytes[10]).toBe(0x03);
    // returnList size=1 at offset 14
    expect(bytes[14]).toBe(0x01);
    expect(bytes[15]).toBe(0x00);
    // baselineCommandCount=0 at offset 18
    expect(bytes[18]).toBe(0x00);
    expect(bytes[21]).toBe(0x00);
    // Unicode 'a' char-count=1 at offset 22
    expect(bytes[22]).toBe(0x01);
    expect(bytes[23]).toBe(0x00);
    // UTF-16 LE 'a' = 0x61 0x00 at offset 26
    expect(bytes[26]).toBe(0x61);
    expect(bytes[27]).toBe(0x00);
  });
});
