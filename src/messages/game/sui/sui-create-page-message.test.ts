import { describe, expect, it } from 'vitest';

import { encodeMessage, parseHeader } from '../../base.js';
import { messageRegistry } from '../../registry.js';
import { SuiCreatePageMessage } from './sui-create-page-message.js';

import './sui-create-page-message.js';

describe('SuiCreatePageMessage', () => {
  it('has the expected metadata', () => {
    expect(SuiCreatePageMessage.messageName).toBe('SuiCreatePageMessage');
    expect(SuiCreatePageMessage.varCount).toBe(2);
    expect(SuiCreatePageMessage.typeCrc).toBeGreaterThan(0);
  });

  it('round-trips encode → decode preserving opaque payload', () => {
    const payload = new Uint8Array([0x07, 0x00, 0x00, 0x00, 0xde, 0xad, 0xbe, 0xef, 0x01, 0x02]);
    const original = new SuiCreatePageMessage(payload);
    const bytes = encodeMessage(original);

    const { varCount, typeCrc, payload: iter } = parseHeader(bytes);
    expect(varCount).toBe(2);
    expect(typeCrc).toBe(SuiCreatePageMessage.typeCrc);

    const decoder = messageRegistry.getByCrc(typeCrc);
    if (!decoder) throw new Error('decoder not registered');
    const decoded = decoder.decodePayload(iter);
    expect(decoded).toBeInstanceOf(SuiCreatePageMessage);
    if (!(decoded instanceof SuiCreatePageMessage)) throw new Error('typeguard');
    expect(Array.from(decoded.pageData)).toEqual(Array.from(payload));
  });

  it('extracts the leading pageId from the opaque payload', () => {
    // pageId = 0x0000_0007 LE
    const msg = new SuiCreatePageMessage(new Uint8Array([0x07, 0x00, 0x00, 0x00, 0xff]));
    expect(msg.pageId).toBe(7);
  });

  it('returns null pageId for empty payloads', () => {
    expect(new SuiCreatePageMessage(new Uint8Array(0)).pageId).toBeNull();
    expect(new SuiCreatePageMessage(new Uint8Array([0x01, 0x02])).pageId).toBeNull();
  });

  it('has the exact byte layout we expect', () => {
    const msg = new SuiCreatePageMessage(new Uint8Array([0xaa, 0xbb]));
    const bytes = encodeMessage(msg);
    // Header: varCount=2 (u16 LE) + typeCrc (u32 LE) = 6 bytes
    // Payload: 2 opaque bytes
    expect(bytes.length).toBe(8);
    expect(bytes[0]).toBe(0x02);
    expect(bytes[1]).toBe(0x00);
    expect(bytes[6]).toBe(0xaa);
    expect(bytes[7]).toBe(0xbb);
  });
});
