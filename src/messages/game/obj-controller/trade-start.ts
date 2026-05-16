/**
 * TradeStart (CM_secureTrade = 277) — bidirectional.
 *
 * Carries every step of the secure-trade handshake (initiate, request,
 * accept, deny, etc.). The `tradeMessageId` field discriminates which
 * step — see `TradeMessageId` for the full enum. The most common values
 * are `RequestTrade` (the inviter opening a trade window) and
 * `TradeRequested` (the invitee receiving the prompt).
 *
 * Wire layout (trailer only — from MessageQueueSecureTrade::pack):
 *   [i32]                 tradeMessageId   (TradeMessageId enum)
 *   [NetworkId (i64 LE)]  initiatorId
 *   [NetworkId (i64 LE)]  recipientId
 *
 * Source:
 *   /home/tharper/code/swg-main/src/engine/shared/library/sharedNetworkMessages/src/shared/clientGameServer/MessageQueueSecureTrade.cpp:79-106
 *   /home/tharper/code/swg-main/src/engine/shared/library/sharedNetworkMessages/src/shared/clientGameServer/MessageQueueSecureTrade.h  (TradeMessageId enum)
 */

import type { IByteStream, IReadIterator } from '../../../archive/interface.js';
import { NetworkIdCodec } from '../../../archive/network-id.js';
import type { NetworkId } from '../../../types.js';
import { ObjControllerSubtypeIds, registerObjControllerSubtype } from './registry.js';

/**
 * The TradeMessageId enum (auto-numbered from 0 in the C++ header). The
 * values are stable on-wire — each step of the trade handshake reuses
 * `CM_secureTrade` with one of these as the discriminator.
 */
export const TradeMessageId = {
  RequestTrade: 0,
  TradeRequested: 1,
  AcceptTrade: 2,
  DeniedTrade: 3,
  DeniedPlayerBusy: 4,
  DeniedPlayerUnreachable: 5,
  RequestTradeReversed: 6,
} as const;

export interface TradeStartData {
  /** Which step of the trade handshake; see `TradeMessageId` for values. */
  tradeMessageId: number;
  /** The player initiating the trade. */
  initiatorId: NetworkId;
  /** The intended trade partner. */
  recipientId: NetworkId;
}

export const TradeStartKind = 'TradeStart' as const;

export const TradeStartDecoder = registerObjControllerSubtype<TradeStartData>({
  kind: TradeStartKind,
  subtypeId: ObjControllerSubtypeIds.CM_secureTrade,
  encode(stream: IByteStream, data: TradeStartData): void {
    stream.writeI32(data.tradeMessageId);
    NetworkIdCodec.encode(stream, data.initiatorId);
    NetworkIdCodec.encode(stream, data.recipientId);
  },
  decode(iter: IReadIterator): TradeStartData {
    const tradeMessageId = iter.readI32();
    const initiatorId = NetworkIdCodec.decode(iter);
    const recipientId = NetworkIdCodec.decode(iter);
    return { tradeMessageId, initiatorId, recipientId };
  },
});
