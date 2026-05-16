/**
 * ChatRequestRoomList — client-to-server; empty body. Asks the chat server
 * to dump the full set of public chat rooms the requesting account is
 * allowed to see. The server replies with a single ChatRoomList.
 *
 * Wire layout: empty.
 *
 * Source:
 *   /home/tharper/code/swg-main/src/engine/shared/library/sharedNetworkMessages/src/shared/chat/ChatRequestRoomList.{h,cpp}
 */

import type { IByteStream, IReadIterator } from '../../../archive/interface.js';
import { GameNetworkMessage, asDecoder, defineMessageMeta } from '../../base.js';
import { registerMessage } from '../../registry.js';

const META = defineMessageMeta('ChatRequestRoomList');

export class ChatRequestRoomList extends GameNetworkMessage {
  static override readonly messageName = META.messageName;
  static readonly typeCrc = META.typeCrc;
  /** cmd only (empty body) */
  static override readonly varCount = 1;

  encodePayload(_stream: IByteStream): void {
    // empty body
  }

  static decodePayload(_iter: IReadIterator): ChatRequestRoomList {
    return new ChatRequestRoomList();
  }
}

export const ChatRequestRoomListDecoder = registerMessage(asDecoder(ChatRequestRoomList));
