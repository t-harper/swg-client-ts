import { describe, expect, it } from 'vitest';

import { encodeMessage, parseHeader } from '../../base.js';
import { GetAuctionDetailsResponse } from './get-auction-details-response.js';

import './get-auction-details-response.js';

describe('GetAuctionDetailsResponse', () => {
  it('has the expected metadata', () => {
    expect(GetAuctionDetailsResponse.messageName).toBe('GetAuctionDetailsResponse');
    expect(GetAuctionDetailsResponse.varCount).toBe(2);
    expect(GetAuctionDetailsResponse.typeCrc).toBeGreaterThan(0);
  });

  it('round-trips with empty property list', () => {
    const msg = new GetAuctionDetailsResponse({
      itemId: 0x1n,
      userDescription: '',
      propertyList: [],
      templateName: '',
      appearanceString: '',
    });
    const bytes = encodeMessage(msg);
    const { payload } = parseHeader(bytes);
    const decoded = GetAuctionDetailsResponse.decodePayload(payload);
    expect(decoded.details.itemId).toBe(0x1n);
    expect(decoded.details.propertyList).toHaveLength(0);
  });

  it('round-trips a realistic details payload', () => {
    const msg = new GetAuctionDetailsResponse({
      itemId: 0xabc1n,
      userDescription: 'A sturdy hunting rifle',
      propertyList: [
        ['damage', '+15'],
        ['range', '64m'],
      ],
      templateName: 'object/weapon/ranged/rifle/rifle_t21.iff',
      appearanceString: 'appearance/wpn_rifle_t21.sat',
    });
    const bytes = encodeMessage(msg);
    const { payload } = parseHeader(bytes);
    const decoded = GetAuctionDetailsResponse.decodePayload(payload);
    expect(decoded.details.itemId).toBe(0xabc1n);
    expect(decoded.details.userDescription).toBe('A sturdy hunting rifle');
    expect(decoded.details.propertyList).toHaveLength(2);
    expect(decoded.details.propertyList[0]).toEqual(['damage', '+15']);
    expect(decoded.details.propertyList[1]).toEqual(['range', '64m']);
    expect(decoded.details.templateName).toBe('object/weapon/ranged/rifle/rifle_t21.iff');
    expect(decoded.details.appearanceString).toBe('appearance/wpn_rifle_t21.sat');
  });
});
