/**
 * ChatRoomList — server-to-client. The chat server's reply to
 * ChatRequestRoomList: every public room the client can see.
 *
 * Wire layout (addVariable order — single AutoArray<ChatRoomData>):
 *   [u32 count][ChatRoomData × count]
 *
 * Each ChatRoomData is described in `chat-room-data.ts`.
 *
 * Source:
 *   /home/tharper/code/swg-main/src/engine/shared/library/sharedNetworkMessages/src/shared/chat/ChatRoomList.{h,cpp}
 */

import type { IByteStream, IReadIterator } from '../../../archive/interface.js';
import { GameNetworkMessage, asDecoder, defineMessageMeta } from '../../base.js';
import { registerMessage } from '../../registry.js';
import { type ChatRoomData, readChatRoomData, writeChatRoomData } from './chat-room-data.js';

const META = defineMessageMeta('ChatRoomList');

export class ChatRoomList extends GameNetworkMessage {
  static override readonly messageName = META.messageName;
  static readonly typeCrc = META.typeCrc;
  /** cmd + roomData (AutoArray) */
  static override readonly varCount = 2;

  constructor(public readonly roomData: readonly ChatRoomData[]) {
    super();
  }

  encodePayload(stream: IByteStream): void {
    // AutoArray<ChatRoomData>: u32 count + entries
    stream.writeU32(this.roomData.length);
    for (const r of this.roomData) writeChatRoomData(stream, r);
  }

  static decodePayload(iter: IReadIterator): ChatRoomList {
    const n = iter.readU32();
    const rooms: ChatRoomData[] = [];
    for (let i = 0; i < n; i++) rooms.push(readChatRoomData(iter));
    return new ChatRoomList(rooms);
  }
}

export const ChatRoomListDecoder = registerMessage(asDecoder(ChatRoomList));
