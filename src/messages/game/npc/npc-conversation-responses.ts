// NpcConversationResponses (CM_npcConversationResponses = 224) — S→C.
// The menu of options the player can pick in response to the current NPC prompt.
// Always follows a CM_npcConversationMessage(223) for the same conversation.
// Wire: `MessageQueueStringList` — `[u8 count][UnicodeString]*count`.
// Source: ~/code/swg-main/src/engine/shared/library/sharedNetworkMessages/src/shared/clientGameServer/MessageQueueStringList.{h,cpp}

import type { IByteStream, IReadIterator } from '../../../archive/interface.js';
import { readUnicodeString, writeUnicodeString } from '../../../archive/unicode-string.js';
import {
  ObjControllerSubtypeIds,
  registerObjControllerSubtype,
} from '../obj-controller/registry.js';

export interface NpcConversationResponsesData {
  /** Display strings for the menu options. Empty when the conversation has no choices (auto-advance). */
  responses: string[];
}

export const NpcConversationResponsesKind = 'NpcConversationResponses' as const;

export const NpcConversationResponsesDecoder =
  registerObjControllerSubtype<NpcConversationResponsesData>({
    kind: NpcConversationResponsesKind,
    subtypeId: ObjControllerSubtypeIds.CM_npcConversationResponses,
    encode(stream: IByteStream, data: NpcConversationResponsesData): void {
      stream.writeU8(data.responses.length & 0xff);
      for (const r of data.responses) {
        writeUnicodeString(stream, r);
      }
    },
    decode(iter: IReadIterator): NpcConversationResponsesData {
      const count = iter.readU8();
      const responses: string[] = [];
      for (let i = 0; i < count; i++) {
        responses.push(readUnicodeString(iter));
      }
      return { responses };
    },
  });
