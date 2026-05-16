/**
 * DraftSchematics (CM_draftSchematicsMessage = 258) — server-to-client.
 *
 * Sent right after the server accepts a `requestCraftingSession` for a tool /
 * crafting station. Carries the list of draft schematics the player knows
 * (i.e. those granted by their current skills). The client uses this list
 * to populate the "Available Schematics" pane of the crafting UI.
 *
 * Note this is **not** a top-level `GameNetworkMessage`; in the C++ tree the
 * payload (`MessageQueueDraftSchematics`) is the trailer of an
 * `ObjControllerMessage` whose `message` field is `CM_draftSchematicsMessage`.
 * The wire format here is therefore the trailer only — the 20-byte parent
 * header is handled upstream by `ObjControllerMessage::decodePayload`.
 *
 * Wire layout (trailer only):
 *   [NetworkId (i64 LE)]  toolId
 *   [NetworkId (i64 LE)]  stationId        (0 when not at a crafting station)
 *   [i32]                 count
 *   for each schematic:
 *     [u32]               serverCrc        constcrc of the server template
 *     [u32]               sharedCrc        constcrc of the shared template
 *     [i32]               category         skill / discipline grouping
 *
 * Source:
 *   /home/tharper/code/swg-main/src/engine/shared/library/sharedNetworkMessages/src/shared/clientGameServer/MessageQueueDraftSchematics.cpp:67-109
 */

import type { IByteStream, IReadIterator } from '../../../archive/interface.js';
import { NetworkIdCodec } from '../../../archive/network-id.js';
import type { NetworkId } from '../../../types.js';
import {
  ObjControllerSubtypeIds,
  registerObjControllerSubtype,
} from '../obj-controller/registry.js';

/** One entry in the player's known-schematics list. */
export interface DraftSchematicEntry {
  /** constcrc of the server template name (e.g. `object/draft_schematic/.../foo.iff`). */
  serverCrc: number;
  /** constcrc of the corresponding shared template (the client-visible variant). */
  sharedCrc: number;
  /** Discipline / category index (used to group entries in the crafting UI). */
  category: number;
}

export interface DraftSchematicsData {
  /** NetworkId of the crafting tool that initiated the session. */
  toolId: NetworkId;
  /** NetworkId of the nearby crafting station, or `0n` when crafting standalone. */
  stationId: NetworkId;
  /** The schematics the player currently has access to. */
  schematics: DraftSchematicEntry[];
}

export const DraftSchematicsKind = 'DraftSchematics' as const;

export const DraftSchematicsDecoder = registerObjControllerSubtype<DraftSchematicsData>({
  kind: DraftSchematicsKind,
  subtypeId: ObjControllerSubtypeIds.CM_draftSchematicsMessage,
  encode(stream: IByteStream, data: DraftSchematicsData): void {
    NetworkIdCodec.encode(stream, data.toolId);
    NetworkIdCodec.encode(stream, data.stationId);
    stream.writeI32(data.schematics.length);
    for (const s of data.schematics) {
      stream.writeU32(s.serverCrc);
      stream.writeU32(s.sharedCrc);
      stream.writeI32(s.category);
    }
  },
  decode(iter: IReadIterator): DraftSchematicsData {
    const toolId = NetworkIdCodec.decode(iter);
    const stationId = NetworkIdCodec.decode(iter);
    const count = iter.readI32();
    if (count < 0) {
      throw new RangeError(`DraftSchematics decode: negative count ${count}`);
    }
    const schematics: DraftSchematicEntry[] = [];
    for (let i = 0; i < count; i++) {
      schematics.push({
        serverCrc: iter.readU32(),
        sharedCrc: iter.readU32(),
        category: iter.readI32(),
      });
    }
    return { toolId, stationId, schematics };
  },
});
