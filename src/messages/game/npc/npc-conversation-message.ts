// NpcConversationMessage (CM_npcConversationMessage = 223) — S→C.
// The NPC's current prompt line, sent each time the conversation advances.
// Always paired with a follow-up CM_npcConversationResponses(224) carrying the
// menu of options the player can pick.
// Source: ~/code/swg-main/src/engine/shared/library/sharedNetworkMessages/src/shared/clientGameServer/MessageQueueNpcConversationMessage.{h,cpp}

import type { IByteStream, IReadIterator } from '../../../archive/interface.js';
import { readUnicodeString, writeUnicodeString } from '../../../archive/unicode-string.js';
import {
  ObjControllerSubtypeIds,
  registerObjControllerSubtype,
} from '../obj-controller/registry.js';

export interface NpcConversationMessageData {
  /** The NPC's prompt text. */
  npcMessage: string;
}

export const NpcConversationMessageKind = 'NpcConversationMessage' as const;

export const NpcConversationMessageDecoder =
  registerObjControllerSubtype<NpcConversationMessageData>({
    kind: NpcConversationMessageKind,
    subtypeId: ObjControllerSubtypeIds.CM_npcConversationMessage,
    encode(stream: IByteStream, data: NpcConversationMessageData): void {
      writeUnicodeString(stream, data.npcMessage);
    },
    decode(iter: IReadIterator): NpcConversationMessageData {
      return { npcMessage: readUnicodeString(iter) };
    },
  });
