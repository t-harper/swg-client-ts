/**
 * ChatPersistentMessageToServer — client-to-server. Send an in-game mail
 * (`/mail`) to another character. The server persists the message for
 * delivery whenever the recipient next logs in.
 *
 * The C++ ctor truncates `message` to 4000 chars (MAX_MESSAGE_SIZE,
 * ChatPersistentMessageToServer.cpp:15). We do the same in the constructor
 * to keep encode bytes well under the SOE-MTU fragmentation threshold.
 *
 * Wire layout (addVariable order from ChatPersistentMessageToServer.cpp:21-25):
 *   [UnicodeString]   message
 *   [UnicodeString]   outOfBand
 *   [u32]             sequence
 *   [UnicodeString]   subject
 *   [ChatAvatarId]    toCharacterName
 *
 * Source:
 *   /home/tharper/code/swg-main/src/engine/shared/library/sharedNetworkMessages/src/shared/chat/ChatPersistentMessageToServer.{h,cpp}
 */

import type { IByteStream, IReadIterator } from '../../../archive/interface.js';
import { readUnicodeString, writeUnicodeString } from '../../../archive/unicode-string.js';
import { GameNetworkMessage, asDecoder, defineMessageMeta } from '../../base.js';
import { registerMessage } from '../../registry.js';
import { type ChatAvatarId, readChatAvatarId, writeChatAvatarId } from './chat-avatar-id.js';

const META = defineMessageMeta('ChatPersistentMessageToServer');

/** C++ MAX_MESSAGE_SIZE in ChatPersistentMessageToServerNamespace (header). */
export const PERSISTENT_MESSAGE_MAX_SIZE = 4000;

export class ChatPersistentMessageToServer extends GameNetworkMessage {
  static override readonly messageName = META.messageName;
  static readonly typeCrc = META.typeCrc;
  /** cmd + message + outOfBand + sequence + subject + toCharacterName */
  static override readonly varCount = 6;

  readonly message: string;
  readonly outOfBand: string;
  readonly sequence: number;
  readonly subject: string;
  readonly toCharacterName: ChatAvatarId;

  constructor(
    sequence: number,
    toCharacterName: ChatAvatarId,
    subject: string,
    message: string,
    outOfBand: string,
  ) {
    super();
    this.sequence = sequence;
    this.toCharacterName = toCharacterName;
    this.subject = subject;
    // Mirror the C++ truncation so over-long bodies don't blow the
    // SOE send budget — and so encode size always matches what the
    // server would emit if it re-serialized the same input.
    this.message =
      message.length > PERSISTENT_MESSAGE_MAX_SIZE
        ? message.substring(0, PERSISTENT_MESSAGE_MAX_SIZE)
        : message;
    this.outOfBand = outOfBand;
  }

  encodePayload(stream: IByteStream): void {
    writeUnicodeString(stream, this.message);
    writeUnicodeString(stream, this.outOfBand);
    stream.writeU32(this.sequence);
    writeUnicodeString(stream, this.subject);
    writeChatAvatarId(stream, this.toCharacterName);
  }

  static decodePayload(iter: IReadIterator): ChatPersistentMessageToServer {
    const message = readUnicodeString(iter);
    const outOfBand = readUnicodeString(iter);
    const sequence = iter.readU32();
    const subject = readUnicodeString(iter);
    const toCharacterName = readChatAvatarId(iter);
    return new ChatPersistentMessageToServer(
      sequence,
      toCharacterName,
      subject,
      message,
      outOfBand,
    );
  }
}

export const ChatPersistentMessageToServerDecoder = registerMessage(
  asDecoder(ChatPersistentMessageToServer),
);
