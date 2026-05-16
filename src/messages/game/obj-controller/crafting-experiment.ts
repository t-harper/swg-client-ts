/**
 * CraftingExperiment / CraftExperiment (CM_experimentMessage = 262)
 *  — client-to-server.
 *
 * Sent during the experimentation stage of crafting. Carries a list of
 * (attribute, experimentPoints) pairs — one entry per attribute the player
 * is spending experiment points on this attempt — plus the experimentation
 * "core level" (a server-side multiplier used by the success-roll math).
 *
 * Most experiments specify exactly one or two attributes; the vector form
 * exists so the client can batch multiple attribute spends into a single
 * server roundtrip.
 *
 * The server reply rides on `CM_experimentResult` (275), which is *also*
 * a `MessageQueueGenericIntResponse` (same wire shape as `CraftingResult`).
 *
 * Wire layout (trailer only):
 *   [u8]                   sequenceId         per-session correlation id
 *   [i32]                  experimentCount    number of entries to follow
 *   for each entry:
 *     [i32]                attributeIndex     which attribute is being experimented on
 *     [i32]                experimentPoints   how many points to spend on it
 *   [i32]                  coreLevel          experimentation level (server uses this for roll math)
 *
 * Source:
 *   /home/tharper/code/swg-main/src/engine/shared/library/sharedNetworkMessages/src/shared/clientGameServer/MessageQueueCraftExperiment.cpp:32-76
 */

import type { IByteStream, IReadIterator } from '../../../archive/interface.js';
import { ObjControllerSubtypeIds, registerObjControllerSubtype } from './registry.js';

export interface CraftingExperimentEntry {
  /** Zero-based index of the attribute being experimented on. */
  attributeIndex: number;
  /** Points the player is spending on this attribute this attempt. */
  experimentPoints: number;
}

export interface CraftingExperimentData {
  /** Per-session correlation id; echoed in the server's CM_experimentResult reply. */
  sequenceId: number;
  /** One entry per attribute the player is spending points on. */
  experiments: CraftingExperimentEntry[];
  /** Experimentation "core level" — server uses this in its success-roll math. */
  coreLevel: number;
}

export const CraftingExperimentKind = 'CraftingExperiment' as const;

export const CraftingExperimentDecoder = registerObjControllerSubtype<CraftingExperimentData>({
  kind: CraftingExperimentKind,
  subtypeId: ObjControllerSubtypeIds.CM_experimentMessage,
  encode(stream: IByteStream, data: CraftingExperimentData): void {
    stream.writeU8(data.sequenceId);
    stream.writeI32(data.experiments.length);
    for (const e of data.experiments) {
      stream.writeI32(e.attributeIndex);
      stream.writeI32(e.experimentPoints);
    }
    stream.writeI32(data.coreLevel);
  },
  decode(iter: IReadIterator): CraftingExperimentData {
    const sequenceId = iter.readU8();
    const count = iter.readI32();
    if (count < 0) {
      throw new RangeError(`CraftingExperiment decode: negative experiment count ${count}`);
    }
    const experiments: CraftingExperimentEntry[] = [];
    for (let i = 0; i < count; i++) {
      const attributeIndex = iter.readI32();
      const experimentPoints = iter.readI32();
      experiments.push({ attributeIndex, experimentPoints });
    }
    const coreLevel = iter.readI32();
    return { sequenceId, experiments, coreLevel };
  },
});
