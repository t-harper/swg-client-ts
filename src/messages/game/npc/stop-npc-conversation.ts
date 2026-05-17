// StopNpcConversation (CM_npcConversationStop = 222) — both directions.
// Client sends a minimal stop to end its side; server pushes a populated version
// with the NPC's farewell when the conversation closes naturally.
// Source: ~/code/swg-main/src/engine/shared/library/sharedNetworkMessages/src/shared/clientGameServer/MessageQueueStopNpcConversation.{h,cpp}

import type { IByteStream, IReadIterator } from '../../../archive/interface.js';
import { NetworkIdCodec } from '../../../archive/network-id.js';
import { readStdString, writeStdString } from '../../../archive/string.js';
import { readUnicodeString, writeUnicodeString } from '../../../archive/unicode-string.js';
import type { NetworkId } from '../../../types.js';
import {
  ObjControllerSubtypeIds,
  registerObjControllerSubtype,
} from '../obj-controller/registry.js';

/**
 * A `StringId` is a `(table, textIndex, text)` triple on the wire.
 * Source: ~/code/swg-main/src/external/ours/library/localizationArchive/src/shared/StringIdArchive.cpp
 */
export interface NpcStringId {
  /** Localization table name, e.g. `"survey"`. */
  table: string;
  /** Mutable index — server sometimes sends 0; the client looks up by name. */
  textIndex: number;
  /** Table key. */
  text: string;
}

export const EMPTY_NPC_STRING_ID: NpcStringId = {
  table: '',
  textIndex: 0,
  text: '',
};

export interface StopNpcConversationData {
  /** The NPC's NetworkId. */
  npc: NetworkId;
  /** Final farewell as a StringId reference (table + text key). */
  finalMessageId: NpcStringId;
  /** Final farewell as already-rendered prose (ProsePackage encoded). */
  finalMessageProse: string;
  /** The player's final response text (mostly empty on the wire). */
  finalResponse: string;
}

export const StopNpcConversationKind = 'StopNpcConversation' as const;

function writeStringId(stream: IByteStream, v: NpcStringId): void {
  writeStdString(stream, v.table);
  stream.writeU32(v.textIndex);
  writeStdString(stream, v.text);
}

function readStringId(iter: IReadIterator): NpcStringId {
  const table = readStdString(iter);
  const textIndex = iter.readU32();
  const text = readStdString(iter);
  return { table, textIndex, text };
}

export const StopNpcConversationDecoder = registerObjControllerSubtype<StopNpcConversationData>({
  kind: StopNpcConversationKind,
  subtypeId: ObjControllerSubtypeIds.CM_npcConversationStop,
  encode(stream: IByteStream, data: StopNpcConversationData): void {
    NetworkIdCodec.encode(stream, data.npc);
    writeStringId(stream, data.finalMessageId);
    writeUnicodeString(stream, data.finalMessageProse);
    writeUnicodeString(stream, data.finalResponse);
  },
  decode(iter: IReadIterator): StopNpcConversationData {
    const npc = NetworkIdCodec.decode(iter);
    const finalMessageId = readStringId(iter);
    const finalMessageProse = readUnicodeString(iter);
    const finalResponse = readUnicodeString(iter);
    return { npc, finalMessageId, finalMessageProse, finalResponse };
  },
});
