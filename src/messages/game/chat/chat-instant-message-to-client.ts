/**
 * ChatInstantMessageToClient — server-to-client. The chat server's delivery
 * of an incoming `/tell`. Mirror of ChatInstantMessageToCharacter, minus the
 * sequence number (which only the originator needs).
 *
 * Wire layout (addVariable order from ChatInstantMessageToClient.cpp:18-20):
 *   [ChatAvatarId]   fromName    (sender)
 *   [UnicodeString]  message
 *   [UnicodeString]  outOfBand
 *
 * Source:
 *   /home/tharper/code/swg-main/src/engine/shared/library/sharedNetworkMessages/src/shared/chat/ChatInstantMessageToClient.{h,cpp}
 */

import type { IByteStream, IReadIterator } from '../../../archive/interface.js';
import { readUnicodeString, writeUnicodeString } from '../../../archive/unicode-string.js';
import { GameNetworkMessage, asDecoder, defineMessageMeta } from '../../base.js';
import { registerMessage } from '../../registry.js';
import { type ChatAvatarId, readChatAvatarId, writeChatAvatarId } from './chat-avatar-id.js';

const META = defineMessageMeta('ChatInstantMessageToClient');

export class ChatInstantMessageToClient extends GameNetworkMessage {
  static override readonly messageName = META.messageName;
  static readonly typeCrc = META.typeCrc;
  /** cmd + fromName + message + outOfBand */
  static override readonly varCount = 4;

  constructor(
    public readonly fromName: ChatAvatarId,
    public readonly message: string,
    public readonly outOfBand: string,
  ) {
    super();
  }

  encodePayload(stream: IByteStream): void {
    writeChatAvatarId(stream, this.fromName);
    writeUnicodeString(stream, this.message);
    writeUnicodeString(stream, this.outOfBand);
  }

  static decodePayload(iter: IReadIterator): ChatInstantMessageToClient {
    const fromName = readChatAvatarId(iter);
    const message = readUnicodeString(iter);
    const outOfBand = readUnicodeString(iter);
    return new ChatInstantMessageToClient(fromName, message, outOfBand);
  }
}

export const ChatInstantMessageToClientDecoder = registerMessage(
  asDecoder(ChatInstantMessageToClient),
);
