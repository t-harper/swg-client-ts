/**
 * AcceptTransactionMessage — bidirectional, empty body.
 *
 * The sender's "I accept the current trade contents" checkbox. The server
 * tracks both parties' accept state; when BOTH are accepted, the server
 * pushes `BeginVerificationMessage` followed by `VerifyTradeMessage` to
 * each party. Either party calling `UnAcceptTransactionMessage` rolls
 * everyone back to the "modify" stage.
 *
 * Wire layout: empty.
 *
 * Source:
 *   /home/tharper/code/swg-main/src/engine/shared/library/sharedNetworkMessages/src/shared/clientGameServer/SecureTradeMessages.{h,cpp}
 */

import type { IByteStream, IReadIterator } from '../../../archive/interface.js';
import { GameNetworkMessage, asDecoder, defineMessageMeta } from '../../base.js';
import { registerMessage } from '../../registry.js';

const META = defineMessageMeta('AcceptTransactionMessage');

export class AcceptTransactionMessage extends GameNetworkMessage {
  static override readonly messageName = META.messageName;
  static readonly typeCrc = META.typeCrc;
  /** cmd only (empty body) */
  static override readonly varCount = 1;

  encodePayload(_stream: IByteStream): void {
    // empty body
  }

  static decodePayload(_iter: IReadIterator): AcceptTransactionMessage {
    return new AcceptTransactionMessage();
  }
}

export const AcceptTransactionMessageDecoder = registerMessage(asDecoder(AcceptTransactionMessage));
