/**
 * ChatSendToRoom — client-to-server. Post a message into an already-entered
 * chat room (channel). The C++ ctor signature is
 * `(sequence, roomId, message, outOfBand)` but the addVariable order writes
 * `message` first.
 *
 * Wire layout (addVariable order from ChatSendToRoom.cpp:19-22):
 *   [UnicodeString]   message
 *   [UnicodeString]   outOfBand
 *   [u32]             roomId
 *   [u32]             sequence
 *
 * Source:
 *   /home/tharper/code/swg-main/src/engine/shared/library/sharedNetworkMessages/src/shared/chat/ChatSendToRoom.{h,cpp}
 */

import type { IByteStream, IReadIterator } from '../../../archive/interface.js';
import { readUnicodeString, writeUnicodeString } from '../../../archive/unicode-string.js';
import { GameNetworkMessage, asDecoder, defineMessageMeta } from '../../base.js';
import { registerMessage } from '../../registry.js';

const META = defineMessageMeta('ChatSendToRoom');

export class ChatSendToRoom extends GameNetworkMessage {
  static override readonly messageName = META.messageName;
  static readonly typeCrc = META.typeCrc;
  /** cmd + message + outOfBand + roomId + sequence */
  static override readonly varCount = 5;

  /**
   * @param sequence - client-side correlation echoed back via ChatOnSendRoomMessage
   * @param roomId   - the numeric id (from ChatRoomData.id, or from a join reply)
   * @param message  - Unicode body
   * @param outOfBand- style/markup payload (usually '')
   */
  constructor(
    public readonly sequence: number,
    public readonly roomId: number,
    public readonly message: string,
    public readonly outOfBand: string,
  ) {
    super();
  }

  encodePayload(stream: IByteStream): void {
    writeUnicodeString(stream, this.message);
    writeUnicodeString(stream, this.outOfBand);
    stream.writeU32(this.roomId);
    stream.writeU32(this.sequence);
  }

  static decodePayload(iter: IReadIterator): ChatSendToRoom {
    const message = readUnicodeString(iter);
    const outOfBand = readUnicodeString(iter);
    const roomId = iter.readU32();
    const sequence = iter.readU32();
    return new ChatSendToRoom(sequence, roomId, message, outOfBand);
  }
}

export const ChatSendToRoomDecoder = registerMessage(asDecoder(ChatSendToRoom));
