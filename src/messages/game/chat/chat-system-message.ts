/**
 * ChatSystemMessage — server → client. The "system message" that shows up
 * in the chat window or as a floating notification. Used by the server for
 * every prose-message broadcast: skill grant feedback, sample-tool errors,
 * combat narration, mission updates, etc.
 *
 * Wire layout (addVariable order from ChatSystemMessage.cpp:19-21):
 *   [u8]              flags        — display routing (CHAT_BOX=0x00,
 *                                    QUICK_TEXT=0x01, ON_SCREEN=0x02, ...)
 *   [UnicodeString]   message      — the localized prose (UTF-16 LE)
 *   [UnicodeString]   outOfBand    — STF-string tokens for prose substitution
 *
 * Source:
 *   /home/tharper/code/swg-main/src/engine/shared/library/sharedNetworkMessages/src/shared/chat/ChatSystemMessage.cpp
 */

import type { IByteStream, IReadIterator } from '../../../archive/interface.js';
import { readUnicodeString, writeUnicodeString } from '../../../archive/unicode-string.js';
import { GameNetworkMessage, asDecoder, defineMessageMeta } from '../../base.js';
import { registerMessage } from '../../registry.js';

const META = defineMessageMeta('ChatSystemMessage');

/**
 * `flags` field bit values. The server sets one of these to route the
 * message to the right UI element.
 */
export const ChatSystemMessageFlags = {
  /** Show in the chat window (default for most prose). */
  CHAT_BOX: 0x00,
  /** Floating quick-text notification. */
  QUICK_TEXT: 0x01,
  /** On-screen status bar. */
  ON_SCREEN: 0x02,
} as const;

export class ChatSystemMessage extends GameNetworkMessage {
  static override readonly messageName = META.messageName;
  static readonly typeCrc = META.typeCrc;
  /** cmd + flags + message + outOfBand */
  static override readonly varCount = 4;

  constructor(
    public readonly flags: number,
    public readonly message: string,
    public readonly outOfBand: string,
  ) {
    super();
  }

  encodePayload(stream: IByteStream): void {
    stream.writeU8(this.flags);
    writeUnicodeString(stream, this.message);
    writeUnicodeString(stream, this.outOfBand);
  }

  static decodePayload(iter: IReadIterator): ChatSystemMessage {
    const flags = iter.readU8();
    const message = readUnicodeString(iter);
    const outOfBand = readUnicodeString(iter);
    return new ChatSystemMessage(flags, message, outOfBand);
  }
}

export const ChatSystemMessageDecoder = registerMessage(asDecoder(ChatSystemMessage));
