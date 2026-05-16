/**
 * CraftSelectSchematic (CM_selectDraftSchematic = 270) — client-to-server.
 *
 * Sent when the player picks a draft schematic from the list returned in
 * `DraftSchematics`. Carries a single integer: the schematic index within
 * the `DraftSchematicsData.schematics` array the server previously sent.
 *
 * The server reaction is to instantiate a fresh `ManufactureSchematicObject`
 * for the chosen draft and immediately push its slot layout via
 * `DraftSlots` (CM_draftSlotsMessage = 259).
 *
 * Wire layout (trailer only):
 *   [i32]    schematicIndex      index into the DraftSchematics list
 *
 * Source:
 *   /home/tharper/code/swg-main/src/engine/shared/library/sharedNetworkMessages/src/shared/clientGameServer/MessageQueueCraftSelectSchematic.cpp:33-52
 */

import type { IByteStream, IReadIterator } from '../../../archive/interface.js';
import { ObjControllerSubtypeIds, registerObjControllerSubtype } from './registry.js';

export interface CraftSelectSchematicData {
  /** Index into the DraftSchematics list the server previously sent. */
  schematicIndex: number;
}

export const CraftSelectSchematicKind = 'CraftSelectSchematic' as const;

export const CraftSelectSchematicDecoder = registerObjControllerSubtype<CraftSelectSchematicData>({
  kind: CraftSelectSchematicKind,
  subtypeId: ObjControllerSubtypeIds.CM_selectDraftSchematic,
  encode(stream: IByteStream, data: CraftSelectSchematicData): void {
    stream.writeI32(data.schematicIndex);
  },
  decode(iter: IReadIterator): CraftSelectSchematicData {
    return { schematicIndex: iter.readI32() };
  },
});
