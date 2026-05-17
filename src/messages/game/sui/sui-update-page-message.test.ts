import { describe, expect, it } from 'vitest';

import { encodeMessage, parseHeader } from '../../base.js';
import { messageRegistry } from '../../registry.js';
import { type SuiPageData, encodeSuiPageData } from './sui-page-data.js';
import { SuiUpdatePageMessage } from './sui-update-page-message.js';

import './sui-update-page-message.js';

function makePageData(overrides: Partial<SuiPageData> = {}): SuiPageData {
  return {
    pageId: 42,
    pageName: 'banker.update',
    commands: [],
    associatedObjectId: 0n,
    associatedLocation: { x: 0, y: 0, z: 0 },
    maxRangeFromObject: 0,
    ...overrides,
  };
}

describe('SuiUpdatePageMessage', () => {
  it('has the expected metadata', () => {
    expect(SuiUpdatePageMessage.messageName).toBe('SuiUpdatePageMessage');
    expect(SuiUpdatePageMessage.varCount).toBe(2);
    expect(SuiUpdatePageMessage.typeCrc).toBeGreaterThan(0);
  });

  it('round-trips encode → decode preserving the SuiPageData struct', () => {
    const original = new SuiUpdatePageMessage(
      makePageData({
        pageId: 17,
        pageName: 'banker.terminal.update',
        commands: [
          {
            type: 'subscribeToEvent',
            targetWidget: 'btn.ok',
            eventType: 4,
            callback: '',
            propertySubscriptions: [{ widgetName: 'fld.amount', propertyName: 'LocalText' }],
          },
        ],
      }),
    );
    const bytes = encodeMessage(original);

    const { varCount, typeCrc, payload: iter } = parseHeader(bytes);
    expect(varCount).toBe(2);
    expect(typeCrc).toBe(SuiUpdatePageMessage.typeCrc);

    const decoder = messageRegistry.getByCrc(typeCrc);
    if (!decoder) throw new Error('decoder not registered');
    const decoded = decoder.decodePayload(iter);
    expect(decoded).toBeInstanceOf(SuiUpdatePageMessage);
    if (!(decoded instanceof SuiUpdatePageMessage)) throw new Error('typeguard');
    expect(decoded.pageData).toEqual(original.pageData);
  });

  it('accepts a Uint8Array payload and decodes it eagerly', () => {
    const pageBytes = encodeSuiPageData(makePageData({ pageId: 42 }));
    const msg = new SuiUpdatePageMessage(pageBytes);
    expect(msg.pageId).toBe(42);
  });

  it('exposes pageId via the decoded SuiPageData', () => {
    const msg = new SuiUpdatePageMessage(makePageData({ pageId: 42 }));
    expect(msg.pageId).toBe(42);
  });
});
