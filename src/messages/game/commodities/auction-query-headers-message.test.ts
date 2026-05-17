import { describe, expect, it } from 'vitest';

import { encodeMessage, parseHeader } from '../../base.js';
import {
  AdvancedSearchMatchAllAny,
  AuctionLocationSearch,
  AuctionQueryHeadersMessage,
  AuctionSearchType,
  SearchConditionComparison,
} from './auction-query-headers-message.js';

import './auction-query-headers-message.js';

describe('AuctionQueryHeadersMessage', () => {
  it('has the expected metadata', () => {
    expect(AuctionQueryHeadersMessage.messageName).toBe('AuctionQueryHeadersMessage');
    expect(AuctionQueryHeadersMessage.varCount).toBe(17);
    expect(AuctionQueryHeadersMessage.typeCrc).toBeGreaterThan(0);
  });

  it('round-trips a basic browse-all query', () => {
    const msg = new AuctionQueryHeadersMessage({
      locationSearchType: AuctionLocationSearch.Galaxy,
      requestId: 1,
      searchType: AuctionSearchType.ByAll,
      itemType: 0,
      itemTypeExactMatch: false,
      itemTemplateId: 0,
      textFilterAll: '',
      textFilterAny: '',
      priceFilterMin: 0,
      priceFilterMax: 0,
      priceFilterIncludesFee: false,
      advancedSearch: [],
      advancedSearchMatchAllAny: AdvancedSearchMatchAllAny.match_all,
      container: 0xabc1n,
      myVendorsOnly: false,
      queryOffset: 0,
    });
    const bytes = encodeMessage(msg);
    const { payload } = parseHeader(bytes);
    const decoded = AuctionQueryHeadersMessage.decodePayload(payload);
    expect(decoded.fields.locationSearchType).toBe(AuctionLocationSearch.Galaxy);
    expect(decoded.fields.requestId).toBe(1);
    expect(decoded.fields.searchType).toBe(AuctionSearchType.ByAll);
    expect(decoded.fields.container).toBe(0xabc1n);
    expect(decoded.fields.queryOffset).toBe(0);
    expect(decoded.fields.advancedSearch).toHaveLength(0);
  });

  it('round-trips a query with a text filter and price range', () => {
    const msg = new AuctionQueryHeadersMessage({
      locationSearchType: AuctionLocationSearch.Planet,
      requestId: 42,
      searchType: AuctionSearchType.ByCategory,
      itemType: 256,
      itemTypeExactMatch: true,
      itemTemplateId: 0xdead,
      textFilterAll: 'rifle',
      textFilterAny: 'krayt',
      priceFilterMin: 100,
      priceFilterMax: 10000,
      priceFilterIncludesFee: true,
      advancedSearch: [],
      advancedSearchMatchAllAny: AdvancedSearchMatchAllAny.match_all,
      container: 0x4321n,
      myVendorsOnly: false,
      queryOffset: 30,
    });
    const bytes = encodeMessage(msg);
    const { payload } = parseHeader(bytes);
    const decoded = AuctionQueryHeadersMessage.decodePayload(payload);
    expect(decoded.fields.textFilterAll).toBe('rifle');
    expect(decoded.fields.textFilterAny).toBe('krayt');
    expect(decoded.fields.priceFilterMin).toBe(100);
    expect(decoded.fields.priceFilterMax).toBe(10000);
    expect(decoded.fields.priceFilterIncludesFee).toBe(true);
    expect(decoded.fields.itemTypeExactMatch).toBe(true);
    expect(decoded.fields.itemTemplateId).toBe(0xdead);
    expect(decoded.fields.queryOffset).toBe(30);
  });

  it('round-trips advanced search conditions of all three flavors', () => {
    const msg = new AuctionQueryHeadersMessage({
      locationSearchType: AuctionLocationSearch.Galaxy,
      requestId: 7,
      searchType: AuctionSearchType.ByAll,
      itemType: 0,
      itemTypeExactMatch: false,
      itemTemplateId: 0,
      textFilterAll: '',
      textFilterAny: '',
      priceFilterMin: 0,
      priceFilterMax: 0,
      priceFilterIncludesFee: false,
      advancedSearch: [
        {
          attributeNameCrc: 0xdeadbeef,
          requiredAttribute: true,
          comparison: SearchConditionComparison.SCC_int,
          intMin: 10,
          intMax: 99,
          floatMin: 0,
          floatMax: 0,
          stringValue: '',
        },
        {
          attributeNameCrc: 0xc0ffee,
          requiredAttribute: false,
          comparison: SearchConditionComparison.SCC_float,
          intMin: 0,
          intMax: 0,
          floatMin: 1.5,
          floatMax: 3.5,
          stringValue: '',
        },
        {
          attributeNameCrc: 0x42,
          requiredAttribute: true,
          comparison: SearchConditionComparison.SCC_string_contain,
          intMin: 0,
          intMax: 0,
          floatMin: 0,
          floatMax: 0,
          stringValue: 'krayt',
        },
      ],
      advancedSearchMatchAllAny: AdvancedSearchMatchAllAny.match_any,
      container: 0x1n,
      myVendorsOnly: true,
      queryOffset: 0,
    });
    const bytes = encodeMessage(msg);
    const { payload } = parseHeader(bytes);
    const decoded = AuctionQueryHeadersMessage.decodePayload(payload);
    expect(decoded.fields.advancedSearch).toHaveLength(3);
    const conds = decoded.fields.advancedSearch;
    expect(conds[0]?.comparison).toBe(SearchConditionComparison.SCC_int);
    expect(conds[0]?.intMin).toBe(10);
    expect(conds[0]?.intMax).toBe(99);
    expect(conds[1]?.comparison).toBe(SearchConditionComparison.SCC_float);
    expect(conds[1]?.floatMin).toBeCloseTo(1.5);
    expect(conds[1]?.floatMax).toBeCloseTo(3.5);
    expect(conds[2]?.comparison).toBe(SearchConditionComparison.SCC_string_contain);
    expect(conds[2]?.stringValue).toBe('krayt');
    expect(decoded.fields.advancedSearchMatchAllAny).toBe(AdvancedSearchMatchAllAny.match_any);
    expect(decoded.fields.myVendorsOnly).toBe(true);
  });
});
