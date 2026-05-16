import { describe, expect, it } from 'vitest';
import { ByteStream } from '../../../archive/byte-stream.js';
import { ReadIterator } from '../../../archive/read-iterator.js';
import { ObjControllerSubtypeIds, objControllerRegistry } from './registry.js';
import { TradeMessageId, TradeStartDecoder, TradeStartKind } from './trade-start.js';

describe('TradeStart (CM_secureTrade)', () => {
  it('has the right metadata', () => {
    expect(TradeStartDecoder.kind).toBe('TradeStart');
    expect(TradeStartDecoder.subtypeId).toBe(ObjControllerSubtypeIds.CM_secureTrade);
    expect(TradeStartDecoder.subtypeId).toBe(277);
  });

  it('self-registers in the subtype registry', () => {
    const found = objControllerRegistry.getById(ObjControllerSubtypeIds.CM_secureTrade);
    expect(found).toBe(TradeStartDecoder);
    expect(objControllerRegistry.getByKind(TradeStartKind)).toBe(TradeStartDecoder);
  });

  it('round-trips an outgoing RequestTrade', () => {
    const data = {
      tradeMessageId: TradeMessageId.RequestTrade,
      initiatorId: 0xaa11n,
      recipientId: 0xbb22n,
    };
    const s = new ByteStream();
    TradeStartDecoder.encode(s, data);
    const d = TradeStartDecoder.decode(new ReadIterator(s.toBytes()));
    expect(d).toEqual(data);
  });

  it('round-trips an incoming TradeRequested', () => {
    const data = {
      tradeMessageId: TradeMessageId.TradeRequested,
      initiatorId: 0x1n,
      recipientId: 0x2n,
    };
    const s = new ByteStream();
    TradeStartDecoder.encode(s, data);
    const d = TradeStartDecoder.decode(new ReadIterator(s.toBytes()));
    expect(d).toEqual(data);
  });

  it('round-trips DeniedTrade', () => {
    const data = {
      tradeMessageId: TradeMessageId.DeniedTrade,
      initiatorId: 0xffn,
      recipientId: 0xeen,
    };
    const s = new ByteStream();
    TradeStartDecoder.encode(s, data);
    const d = TradeStartDecoder.decode(new ReadIterator(s.toBytes()));
    expect(d).toEqual(data);
  });

  it('has the exact byte layout (4 + 8 + 8 = 20 bytes)', () => {
    const s = new ByteStream();
    TradeStartDecoder.encode(s, {
      tradeMessageId: TradeMessageId.AcceptTrade,
      initiatorId: 1n,
      recipientId: 2n,
    });
    const bytes = s.toBytes();
    expect(bytes.length).toBe(20);
    // tradeMessageId = AcceptTrade = 2
    expect(Array.from(bytes.subarray(0, 4))).toEqual([0x02, 0, 0, 0]);
    // initiatorId = 1
    expect(Array.from(bytes.subarray(4, 12))).toEqual([0x01, 0, 0, 0, 0, 0, 0, 0]);
    // recipientId = 2
    expect(Array.from(bytes.subarray(12, 20))).toEqual([0x02, 0, 0, 0, 0, 0, 0, 0]);
  });

  it('exposes all 7 TradeMessageId values', () => {
    expect(TradeMessageId.RequestTrade).toBe(0);
    expect(TradeMessageId.TradeRequested).toBe(1);
    expect(TradeMessageId.AcceptTrade).toBe(2);
    expect(TradeMessageId.DeniedTrade).toBe(3);
    expect(TradeMessageId.DeniedPlayerBusy).toBe(4);
    expect(TradeMessageId.DeniedPlayerUnreachable).toBe(5);
    expect(TradeMessageId.RequestTradeReversed).toBe(6);
  });
});
