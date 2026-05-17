import { describe, expect, it } from 'vitest';

import { encodeMessage, parseHeader } from '../../base.js';
import { messageRegistry } from '../../registry.js';
import { SuiCreatePageMessage } from './sui-create-page-message.js';
import { type SuiPageData, encodeSuiPageData } from './sui-page-data.js';

import './sui-create-page-message.js';

function makePageData(overrides: Partial<SuiPageData> = {}): SuiPageData {
  return {
    pageId: 7,
    pageName: 'Script.suiCreatePageData',
    commands: [],
    associatedObjectId: 0n,
    associatedLocation: { x: 0, y: 0, z: 0 },
    maxRangeFromObject: 0,
    ...overrides,
  };
}

describe('SuiCreatePageMessage', () => {
  it('has the expected metadata', () => {
    expect(SuiCreatePageMessage.messageName).toBe('SuiCreatePageMessage');
    expect(SuiCreatePageMessage.varCount).toBe(2);
    expect(SuiCreatePageMessage.typeCrc).toBeGreaterThan(0);
  });

  it('round-trips encode → decode preserving the SuiPageData struct', () => {
    const original = new SuiCreatePageMessage(
      makePageData({
        pageId: 42,
        pageName: 'banker.terminal',
        commands: [
          { type: 'setProperty', targetWidget: 'comp.title', propertyName: 'Text', propertyValue: 'Hello' },
        ],
        associatedObjectId: 0xdeadbeefn,
        associatedLocation: { x: 1.5, y: 2.5, z: 3.5 },
        maxRangeFromObject: 16,
      }),
    );
    const bytes = encodeMessage(original);

    const { varCount, typeCrc, payload: iter } = parseHeader(bytes);
    expect(varCount).toBe(2);
    expect(typeCrc).toBe(SuiCreatePageMessage.typeCrc);

    const decoder = messageRegistry.getByCrc(typeCrc);
    if (!decoder) throw new Error('decoder not registered');
    const decoded = decoder.decodePayload(iter);
    expect(decoded).toBeInstanceOf(SuiCreatePageMessage);
    if (!(decoded instanceof SuiCreatePageMessage)) throw new Error('typeguard');
    expect(decoded.pageData).toEqual(original.pageData);
  });

  it('accepts a Uint8Array payload and decodes it eagerly', () => {
    const pageBytes = encodeSuiPageData(makePageData({ pageId: 99, pageName: 'foo' }));
    const msg = new SuiCreatePageMessage(pageBytes);
    expect(msg.pageId).toBe(99);
    expect(msg.pageData.pageName).toBe('foo');
  });

  it('exposes pageId via the decoded SuiPageData', () => {
    const msg = new SuiCreatePageMessage(makePageData({ pageId: 7 }));
    expect(msg.pageId).toBe(7);
  });

  it('round-trips through pageDataBytes', () => {
    const msg = new SuiCreatePageMessage(
      makePageData({ pageId: 11, pageName: 'rt', maxRangeFromObject: 8.25 }),
    );
    const bytes = msg.pageDataBytes;
    const reparsed = new SuiCreatePageMessage(bytes);
    expect(reparsed.pageData).toEqual(msg.pageData);
  });

  it('has the exact byte layout we expect (header + pageData bytes)', () => {
    const page = makePageData({ pageId: 0, pageName: '', maxRangeFromObject: 0 });
    const msg = new SuiCreatePageMessage(page);
    const bytes = encodeMessage(msg);
    const expectedPageBytes = encodeSuiPageData(page);
    // Header: varCount=2 (u16 LE) + typeCrc (u32 LE) = 6 bytes
    expect(bytes.length).toBe(6 + expectedPageBytes.length);
    expect(bytes[0]).toBe(0x02);
    expect(bytes[1]).toBe(0x00);
    expect(Array.from(bytes.slice(6))).toEqual(Array.from(expectedPageBytes));
  });
});
