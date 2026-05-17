/**
 * Barrel: importing this module triggers self-registration of every
 * SecureTrade handshake message into the GameNetworkMessage `messageRegistry`.
 *
 * The 9 messages here model the FULL secure-trade handshake — the
 * post-RequestTrade flow that the original CM_secureTrade subtype only
 * opened the door for. State machine (see `ctx.tradeWith`):
 *
 *   1. Either party fires `CM_secureTrade(RequestTrade)` (the ObjController
 *      subtype, see `obj-controller/trade-start.ts`).
 *   2. Server confirms with `BeginTradeMessage` to both clients.
 *   3. Each party builds their side of the offer:
 *        - `AddItemMessage(itemId)` per item
 *        - `RemoveItemMessage(itemId)` to retract
 *        - `GiveMoneyMessage(credits)`
 *   4. Each party fires `AcceptTransactionMessage` when ready (or
 *      `UnAcceptTransactionMessage` to roll back).
 *   5. When both have accepted, server pushes `VerifyTradeMessage` to each
 *      side; each party echoes it back.
 *   6. Server moves items + credits, then broadcasts `TradeCompleteMessage`
 *      to both sides.
 *   7. Either party may send `AbortTradeMessage` at any point — server
 *      relays it to the other party and discards state.
 *
 * Out-of-scope C++ messages NOT modeled here (file ref:
 * SecureTradeMessages.{h,cpp}):
 *   - `AddItemFailedMessage`     — server-side rejection of `AddItemMessage`
 *     (e.g. item is bound, no-trade flag set). Wire is identical to
 *     `AddItemMessage` (single `NetworkId` AutoVariable).
 *   - `DenyTradeMessage`         — empty body; alternative "trade refused"
 *     path (the `CM_secureTrade(DeniedTrade)` subtype is the more common
 *     refusal route).
 *   - `BeginVerificationMessage` — empty body; informational signal sent by
 *     the server immediately before `VerifyTradeMessage`. The state machine
 *     proceeds correctly whether or not this is observed.
 *
 * Side-effect-import this barrel from `swg-client.ts` so the orchestrator's
 * dispatcher has the decoders available when traffic arrives.
 */

export { AbortTradeMessage, AbortTradeMessageDecoder } from './abort-trade-message.js';
export {
  AcceptTransactionMessage,
  AcceptTransactionMessageDecoder,
} from './accept-transaction-message.js';
export { AddItemMessage, AddItemMessageDecoder } from './add-item-message.js';
export { BeginTradeMessage, BeginTradeMessageDecoder } from './begin-trade-message.js';
export { GiveMoneyMessage, GiveMoneyMessageDecoder } from './give-money-message.js';
export { RemoveItemMessage, RemoveItemMessageDecoder } from './remove-item-message.js';
export { TradeCompleteMessage, TradeCompleteMessageDecoder } from './trade-complete-message.js';
export {
  UnAcceptTransactionMessage,
  UnAcceptTransactionMessageDecoder,
} from './unaccept-transaction-message.js';
export { VerifyTradeMessage, VerifyTradeMessageDecoder } from './verify-trade-message.js';
