// NpcConversationSelectMessage (CM_npcConversationSelect = 225) — C→S.
// Player picks option N from the current dialog menu. The response index is
// carried in the parent ObjControllerMessage's `value` field (cast int → f32
// → int server-side via `respondToNpc((int)value)`); the trailer is EMPTY.
// Source: ~/code/swg-main/src/engine/server/library/serverGame/src/shared/object/TangibleObject_Conversation.cpp:366
//         ~/code/swg-main/src/engine/server/library/serverGame/src/shared/controller/TangibleController.cpp:444

import type { IByteStream, IReadIterator } from '../../../archive/interface.js';
import {
  ObjControllerSubtypeIds,
  registerObjControllerSubtype,
} from '../obj-controller/registry.js';

export interface NpcConversationSelectData {
  // Empty trailer — the response index is carried in
  // `ObjControllerMessage.value` (f32 cast of the int index).
  // This empty interface exists so the subtype-decoder dispatch attaches a
  // typed `decodedSubtype` rather than treating the missing trailer as an
  // unknown subtype.
  readonly _empty?: never;
}

export const NpcConversationSelectKind = 'NpcConversationSelectMessage' as const;

export const NpcConversationSelectDecoder = registerObjControllerSubtype<NpcConversationSelectData>(
  {
    kind: NpcConversationSelectKind,
    subtypeId: ObjControllerSubtypeIds.CM_npcConversationSelect,
    encode(_stream: IByteStream, _data: NpcConversationSelectData): void {
      // empty trailer
    },
    decode(_iter: IReadIterator): NpcConversationSelectData {
      return {};
    },
  },
);
