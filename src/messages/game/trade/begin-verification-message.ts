/**
 * BeginVerificationMessage — server → client, empty body. Sent to BOTH
 * parties after both have sent `AcceptTransactionMessage`. Signals "both
 * accepted; send `VerifyTradeMessage` to confirm the trade contents hash".
 *
 * Wire layout: empty (varCount=1, only the implicit cmd field).
 *
 * Source: ~/code/swg-main/src/engine/shared/library/sharedNetworkMessages/src/shared/clientGameServer/SecureTradeMessages.{h,cpp}
 */

import type { IByteStream, IReadIterator } from '../../../archive/interface.js';
import { GameNetworkMessage, asDecoder, defineMessageMeta } from '../../base.js';
import { registerMessage } from '../../registry.js';

const META = defineMessageMeta('BeginVerificationMessage');

export class BeginVerificationMessage extends GameNetworkMessage {
  static override readonly messageName = META.messageName;
  static readonly typeCrc = META.typeCrc;
  static override readonly varCount = 1;

  encodePayload(_stream: IByteStream): void {}

  static decodePayload(_iter: IReadIterator): BeginVerificationMessage {
    return new BeginVerificationMessage();
  }
}

export const BeginVerificationMessageDecoder = registerMessage(asDecoder(BeginVerificationMessage));
