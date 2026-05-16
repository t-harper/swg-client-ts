/**
 * ChatAvatarId — the chat-system identifier for a character. Used as a
 * field type inside multiple Chat* message classes (not a standalone
 * GameNetworkMessage).
 *
 * Wire layout (Archive::get/put — three sequential std::strings):
 *   [std::string] gameCode    (e.g. "SWG")
 *   [std::string] cluster     (the cluster shortName, e.g. "swg")
 *   [std::string] name        (the character's first-name token, lowercased)
 *
 * Source:
 *   /home/tharper/code/swg-main/src/engine/shared/library/sharedNetworkMessages/src/shared/chat/ChatAvatarId.{h,cpp}
 *   /home/tharper/code/swg-main/src/engine/shared/library/sharedNetworkMessages/src/shared/chat/ChatAvatarIdArchive.{h,cpp}
 */

import type { IByteStream, ICodec, IReadIterator } from '../../../archive/interface.js';
import { readStdString, writeStdString } from '../../../archive/string.js';

export interface ChatAvatarId {
  /** Game shortName — usually "SWG". */
  gameCode: string;
  /** Cluster shortName the character lives on. */
  cluster: string;
  /** Character's first-name token (typically lowercased by the chat server). */
  name: string;
}

/** Build a ChatAvatarId with the conventional defaults — only `name` is required. */
export function chatAvatarId(name: string, cluster = '', gameCode = ''): ChatAvatarId {
  return { gameCode, cluster, name };
}

export function writeChatAvatarId(stream: IByteStream, value: ChatAvatarId): void {
  writeStdString(stream, value.gameCode);
  writeStdString(stream, value.cluster);
  writeStdString(stream, value.name);
}

export function readChatAvatarId(iter: IReadIterator): ChatAvatarId {
  const gameCode = readStdString(iter);
  const cluster = readStdString(iter);
  const name = readStdString(iter);
  return { gameCode, cluster, name };
}

export const ChatAvatarIdCodec: ICodec<ChatAvatarId> = {
  encode: writeChatAvatarId,
  decode: readChatAvatarId,
};
