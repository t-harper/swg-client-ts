/**
 * DeleteCharacterReplyMessage — INBOUND (LoginServer → client)
 *
 * Sent in response to a `DeleteCharacterMessage`. Carries a single int
 * result code from the `DeleteCharacterResult` enum below.
 *
 * Important: a `rc_OK` reply does NOT mean the character row is gone —
 * it just means the LoginServer accepted the request and queued an
 * async DB task. The character continues to appear in
 * `EnumerateCharacterId` until the next login. Callers that need to
 * confirm the delete landed should reconnect and re-fetch the avatar
 * list.
 *
 * Source:
 *   /home/tharper/code/swg-main/src/engine/shared/library/sharedNetworkMessages/src/shared/clientGameServer/DeleteCharacterReplyMessage.{h,cpp}
 *
 * Wire layout (addVariable in DeleteCharacterReplyMessage.cpp:21):
 *   resultCode : int32 LE   (`DeleteCharacterResult` enum)
 */

import type { IByteStream, IReadIterator } from '../../archive/interface.js';
import { GameNetworkMessage, asDecoder, defineMessageMeta } from '../base.js';
import { registerMessage } from '../registry.js';

const META = defineMessageMeta('DeleteCharacterReplyMessage');

/**
 * Matches the C++ `DeleteCharacterReplyMessage::ResultCode` enum
 * (DeleteCharacterReplyMessage.h:23). Default int values: 0, 1, 2.
 */
export enum DeleteCharacterResult {
  OK = 0,
  AlreadyInProgress = 1,
  ClusterDown = 2,
}

export class DeleteCharacterReplyMessage extends GameNetworkMessage {
  static override readonly messageName = META.messageName;
  static readonly typeCrc = META.typeCrc;
  /** cmd + resultCode */
  static override readonly varCount = 2;

  constructor(public readonly resultCode: DeleteCharacterResult) {
    super();
  }

  encodePayload(stream: IByteStream): void {
    stream.writeI32(this.resultCode);
  }

  static decodePayload(iter: IReadIterator): DeleteCharacterReplyMessage {
    return new DeleteCharacterReplyMessage(iter.readI32() as DeleteCharacterResult);
  }
}

export const DeleteCharacterReplyMessageDecoder = registerMessage(
  asDecoder(DeleteCharacterReplyMessage),
);
