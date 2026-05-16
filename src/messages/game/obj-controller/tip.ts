/**
 * Tip (CM_scriptTransferMoney = 364) — server-internal credit transfer.
 *
 * This is the controller-message that backs `/tip <name> <amount>` and
 * the script-side `transferBankCreditsTo` / `transferCashTo` family. The
 * client never *sends* this subtype directly — the user's `/tip` command
 * flows through the CommandQueue, and the auth server then routes the
 * actual money transfer through `CM_scriptTransferMoney` between the
 * source and destination auth servers.
 *
 * We model it so transcripts of cross-server traffic decode cleanly when
 * observed, and so future scripted load tests can inspect the wire shape
 * of a money transfer.
 *
 * Wire layout (trailer only — from MessageQueueScriptTransferMoney::pack):
 *   [i32]                  typeId           (TransactionType enum)
 *   [NetworkId (i64 LE)]   target           (destination object; 0 if using namedAccount)
 *   [std::string]          namedAccount     (named bank account; "" if using target id)
 *   [i32]                  amount           (credits to transfer)
 *   [NetworkId (i64 LE)]   replyTo          (object that gets the callback)
 *   [std::string]          successCallback  (script method name on replyTo)
 *   [std::string]          failCallback     (script method name on replyTo)
 *   [u32]                  packedDictionary length (vector<int8>)
 *   [N bytes]              packedDictionary bytes  (script param dict, opaque)
 *
 * The TransactionType enum lives in `swgServerNetworkMessages/.../MessageQueueScriptTransferMoney.h`
 * (cash↔bank, cash↔cash, cash↔named, etc.); we don't model individual
 * values because the live cluster's exact enum table can shift between
 * builds — callers should treat `typeId` as an opaque int and look it up
 * in the C++ header as needed.
 *
 * Source:
 *   /home/tharper/code/swg-main/src/game/server/library/swgServerNetworkMessages/src/shared/money/MessageQueueScriptTransferMoney.cpp:43-82
 *   /home/tharper/code/swg-main/src/engine/shared/library/sharedFoundation/src/shared/GameControllerMessage.def:463  (CM_scriptTransferMoney = 364)
 */

import type { IByteStream, IReadIterator } from '../../../archive/interface.js';
import { NetworkIdCodec } from '../../../archive/network-id.js';
import { readStdString, writeStdString } from '../../../archive/string.js';
import type { NetworkId } from '../../../types.js';
import { ObjControllerSubtypeIds, registerObjControllerSubtype } from './registry.js';

export interface TipData {
  /** TransactionType enum; opaque int — see C++ header for current values. */
  typeId: number;
  /** Destination NetworkId; `0n` when using `namedAccount`. */
  target: NetworkId;
  /** Named bank account; "" when targeting an object id. */
  namedAccount: string;
  /** Credit amount to transfer. */
  amount: number;
  /** NetworkId of the object that should receive the success/fail callback. */
  replyTo: NetworkId;
  /** Script method name to invoke on `replyTo` after a successful transfer. */
  successCallback: string;
  /** Script method name to invoke on `replyTo` after a failed transfer. */
  failCallback: string;
  /**
   * Opaque packed-dictionary payload (script parameters forwarded to the
   * callback). Most tips send empty; the structured shape is internal to
   * the server-side script engine.
   */
  packedDictionary: Uint8Array;
}

export const TipKind = 'Tip' as const;

export const TipDecoder = registerObjControllerSubtype<TipData>({
  kind: TipKind,
  subtypeId: ObjControllerSubtypeIds.CM_scriptTransferMoney,
  encode(stream: IByteStream, data: TipData): void {
    stream.writeI32(data.typeId);
    NetworkIdCodec.encode(stream, data.target);
    writeStdString(stream, data.namedAccount);
    stream.writeI32(data.amount);
    NetworkIdCodec.encode(stream, data.replyTo);
    writeStdString(stream, data.successCallback);
    writeStdString(stream, data.failCallback);
    // std::vector<int8>: int32 LE length + raw bytes
    stream.writeI32(data.packedDictionary.length);
    stream.writeBytes(data.packedDictionary);
  },
  decode(iter: IReadIterator): TipData {
    const typeId = iter.readI32();
    const target = NetworkIdCodec.decode(iter);
    const namedAccount = readStdString(iter);
    const amount = iter.readI32();
    const replyTo = NetworkIdCodec.decode(iter);
    const successCallback = readStdString(iter);
    const failCallback = readStdString(iter);
    const dictLen = iter.readI32();
    if (dictLen < 0) {
      throw new RangeError(`Tip.packedDictionary: negative length ${dictLen}`);
    }
    const packedDictionary = dictLen > 0 ? iter.readBytes(dictLen) : new Uint8Array(0);
    return {
      typeId,
      target,
      namedAccount,
      amount,
      replyTo,
      successCallback,
      failCallback,
      packedDictionary,
    };
  },
});
