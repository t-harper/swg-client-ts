/**
 * ChatInstantMessageToCharacter — client-to-server. The out-of-game `/tell`
 * primitive: ask the chat server to deliver a Unicode message to another
 * character (online or offline → bounces with an error if offline).
 *
 * Wire layout (addVariable order from ChatInstantMessageToCharacter.cpp:19-22):
 *   [ChatAvatarId]     characterName    (recipient)
 *   [UnicodeString]    message
 *   [UnicodeString]    outOfBand        (style/markup payload — usually "")
 *   [u32]              sequence         (client-side correlation; the server
 *                                        echoes it back in ChatOnSendInstantMessage)
 *
 * Source:
 *   /home/tharper/code/swg-main/src/engine/shared/library/sharedNetworkMessages/src/shared/chat/ChatInstantMessageToCharacter.{h,cpp}
 */

import type { IByteStream, IReadIterator } from '../../../archive/interface.js';
import { readUnicodeString, writeUnicodeString } from '../../../archive/unicode-string.js';
import { GameNetworkMessage, asDecoder, defineMessageMeta } from '../../base.js';
import { registerMessage } from '../../registry.js';
import { type ChatAvatarId, readChatAvatarId, writeChatAvatarId } from './chat-avatar-id.js';

const META = defineMessageMeta('ChatInstantMessageToCharacter');

export class ChatInstantMessageToCharacter extends GameNetworkMessage {
  static override readonly messageName = META.messageName;
  static readonly typeCrc = META.typeCrc;
  /** cmd + characterName + message + outOfBand + sequence */
  static override readonly varCount = 5;

  constructor(
    public readonly characterName: ChatAvatarId,
    public readonly message: string,
    public readonly outOfBand: string,
    public readonly sequence: number,
  ) {
    super();
  }

  encodePayload(stream: IByteStream): void {
    writeChatAvatarId(stream, this.characterName);
    writeUnicodeString(stream, this.message);
    writeUnicodeString(stream, this.outOfBand);
    stream.writeU32(this.sequence);
  }

  static decodePayload(iter: IReadIterator): ChatInstantMessageToCharacter {
    const characterName = readChatAvatarId(iter);
    const message = readUnicodeString(iter);
    const outOfBand = readUnicodeString(iter);
    const sequence = iter.readU32();
    return new ChatInstantMessageToCharacter(characterName, message, outOfBand, sequence);
  }
}

export const ChatInstantMessageToCharacterDecoder = registerMessage(
  asDecoder(ChatInstantMessageToCharacter),
);
