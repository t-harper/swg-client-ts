/**
 * ChatRoomData — describes a chat room (channel). Appears as the element
 * type inside ChatRoomList's `AutoArray<ChatRoomData>`.
 *
 * Wire layout (Archive::get/put — note `path` comes AFTER moderated, not
 * before it as the C++ struct member order would suggest):
 *   [u32]               id
 *   [u32]               roomType         (0 = public, 1 = private)
 *   [u8]                moderated        (0 / 1 flag)
 *   [std::string]       path             (e.g. "SWG.swg.Galaxy")
 *   [ChatAvatarId]      owner
 *   [ChatAvatarId]      creator
 *   [UnicodeString]     title
 *   [i32]               moderatorCount
 *   [ChatAvatarId × N]  moderators
 *   [i32]               inviteeCount
 *   [ChatAvatarId × N]  invitees
 *
 * Source:
 *   /home/tharper/code/swg-main/src/engine/shared/library/sharedNetworkMessages/src/shared/chat/ChatRoomData.{h}
 *   /home/tharper/code/swg-main/src/engine/shared/library/sharedNetworkMessages/src/shared/chat/ChatRoomDataArchive.cpp
 */

import type { IByteStream, ICodec, IReadIterator } from '../../../archive/interface.js';
import { readStdString, writeStdString } from '../../../archive/string.js';
import { readUnicodeString, writeUnicodeString } from '../../../archive/unicode-string.js';
import { type ChatAvatarId, readChatAvatarId, writeChatAvatarId } from './chat-avatar-id.js';

export const ChatRoomType = {
  Public: 0,
  Private: 1,
} as const;

export interface ChatRoomData {
  id: number;
  /** ChatRoomType.Public / ChatRoomType.Private, but wire is raw u32 so we type as number. */
  roomType: number;
  /** Boolean as 0/1 on the wire. */
  moderated: number;
  path: string;
  owner: ChatAvatarId;
  creator: ChatAvatarId;
  title: string;
  moderators: ChatAvatarId[];
  invitees: ChatAvatarId[];
}

export function writeChatRoomData(stream: IByteStream, value: ChatRoomData): void {
  stream.writeU32(value.id);
  stream.writeU32(value.roomType);
  stream.writeU8(value.moderated);
  writeStdString(stream, value.path);
  writeChatAvatarId(stream, value.owner);
  writeChatAvatarId(stream, value.creator);
  writeUnicodeString(stream, value.title);
  // moderators: int32 count + entries (the C++ uses a hand-rolled loop with
  // `int` count — NOT the AutoArray uint32 framing).
  stream.writeI32(value.moderators.length);
  for (const m of value.moderators) writeChatAvatarId(stream, m);
  stream.writeI32(value.invitees.length);
  for (const i of value.invitees) writeChatAvatarId(stream, i);
}

export function readChatRoomData(iter: IReadIterator): ChatRoomData {
  const id = iter.readU32();
  const roomType = iter.readU32();
  const moderated = iter.readU8();
  const path = readStdString(iter);
  const owner = readChatAvatarId(iter);
  const creator = readChatAvatarId(iter);
  const title = readUnicodeString(iter);
  const moderatorCount = iter.readI32();
  if (moderatorCount < 0) {
    throw new RangeError(`ChatRoomData: negative moderatorCount ${moderatorCount}`);
  }
  const moderators: ChatAvatarId[] = [];
  for (let i = 0; i < moderatorCount; i++) moderators.push(readChatAvatarId(iter));
  const inviteeCount = iter.readI32();
  if (inviteeCount < 0) {
    throw new RangeError(`ChatRoomData: negative inviteeCount ${inviteeCount}`);
  }
  const invitees: ChatAvatarId[] = [];
  for (let i = 0; i < inviteeCount; i++) invitees.push(readChatAvatarId(iter));
  return {
    id,
    roomType,
    moderated,
    path,
    owner,
    creator,
    title,
    moderators,
    invitees,
  };
}

export const ChatRoomDataCodec: ICodec<ChatRoomData> = {
  encode: writeChatRoomData,
  decode: readChatRoomData,
};
