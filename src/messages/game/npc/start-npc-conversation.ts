// StartNpcConversation (CM_npcConversationStart = 221) — C→S.
// Player walks up to an NPC and says hello; the server replies with the NPC's
// opening line via CM_npcConversationMessage(223) + a CM_npcConversationResponses(224)
// option menu.
// Source: ~/code/swg-main/src/engine/shared/library/sharedNetworkMessages/src/shared/clientGameServer/MessageQueueStartNpcConversation.{h,cpp}

import type { IByteStream, IReadIterator } from '../../../archive/interface.js';
import { NetworkIdCodec } from '../../../archive/network-id.js';
import { readStdString, writeStdString } from '../../../archive/string.js';
import type { NetworkId } from '../../../types.js';
import {
  ObjControllerSubtypeIds,
  registerObjControllerSubtype,
} from '../obj-controller/registry.js';

/**
 * Who started the conversation? Values from
 * `~/code/swg-main/src/engine/shared/library/sharedGame/include/public/sharedGame/NpcConversationData.h`:
 * `CS_Player = 0`, `CS_Npc = 1`.
 */
export const NpcConversationStarter = {
  Player: 0,
  Npc: 1,
} as const;
export type NpcConversationStarterValue =
  (typeof NpcConversationStarter)[keyof typeof NpcConversationStarter];

export interface StartNpcConversationData {
  /** The NPC's NetworkId. */
  npc: NetworkId;
  /** Who initiated — 0 = player, 1 = npc. Defaults to 0 on the wire. */
  starter: number;
  /** Optional conversation name override (usually empty — the server picks it). */
  conversationName: string;
  /** Optional appearance override template CRC (0 = none). */
  appearanceOverrideTemplateCrc: number;
}

export const StartNpcConversationKind = 'StartNpcConversation' as const;

export const StartNpcConversationDecoder = registerObjControllerSubtype<StartNpcConversationData>({
  kind: StartNpcConversationKind,
  subtypeId: ObjControllerSubtypeIds.CM_npcConversationStart,
  encode(stream: IByteStream, data: StartNpcConversationData): void {
    NetworkIdCodec.encode(stream, data.npc);
    stream.writeU8(data.starter);
    writeStdString(stream, data.conversationName);
    stream.writeU32(data.appearanceOverrideTemplateCrc);
  },
  decode(iter: IReadIterator): StartNpcConversationData {
    const npc = NetworkIdCodec.decode(iter);
    const starter = iter.readU8();
    const conversationName = readStdString(iter);
    const appearanceOverrideTemplateCrc = iter.readU32();
    return { npc, starter, conversationName, appearanceOverrideTemplateCrc };
  },
});
