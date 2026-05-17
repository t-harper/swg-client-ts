// Barrel: importing this module registers every NPC-conversation ObjController
// subtype with `objControllerRegistry`. The NPC conversation handshake is
// modeled entirely as MessageQueue subtypes (no top-level GameNetworkMessages):
//
//   - CM_npcConversationStart (221, C→S)
//   - CM_npcConversationStop  (222, both)
//   - CM_npcConversationMessage   (223, S→C)   ← NPC's prompt
//   - CM_npcConversationResponses (224, S→C)   ← option menu
//   - CM_npcConversationSelect    (225, C→S)   ← player picks (empty trailer)
//
// Side-effect-import this barrel from places that want the NPC decoders
// loaded (e.g. `swg-client.ts`):
//
//   import './messages/game/npc/index.js';

export {
  type NpcConversationMessageData,
  NpcConversationMessageDecoder,
  NpcConversationMessageKind,
} from './npc-conversation-message.js';
export {
  type NpcConversationResponsesData,
  NpcConversationResponsesDecoder,
  NpcConversationResponsesKind,
} from './npc-conversation-responses.js';
export {
  type NpcConversationSelectData,
  NpcConversationSelectDecoder,
  NpcConversationSelectKind,
} from './npc-conversation-select.js';
export {
  NpcConversationStarter,
  type NpcConversationStarterValue,
  type StartNpcConversationData,
  StartNpcConversationDecoder,
  StartNpcConversationKind,
} from './start-npc-conversation.js';
export {
  EMPTY_NPC_STRING_ID,
  type NpcStringId,
  type StopNpcConversationData,
  StopNpcConversationDecoder,
  StopNpcConversationKind,
} from './stop-npc-conversation.js';
