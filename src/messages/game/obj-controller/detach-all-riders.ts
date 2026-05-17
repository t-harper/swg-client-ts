/**
 * DetachAllRiders (CM_detachAllRidersForMount = 1205) — server → server.
 *
 * Sent from a non-authoritative copy of the mount asking the authoritative
 * copy to detach EVERY rider in one shot (used at mount destruction or when
 * the mount goes invalid). The CreatureController on the receiving side
 * calls `owner->detachAllRiders()`.
 *
 * Wire layout (trailer only): EMPTY.
 *
 * Source:
 *   /home/tharper/code/swg-main/src/engine/server/library/serverGame/src/shared/object/CreatureObject_Mounts.cpp:855
 *   /home/tharper/code/swg-main/src/engine/server/library/serverGame/src/shared/controller/CreatureController.cpp:843-845
 */

import type { IByteStream, IReadIterator } from '../../../archive/interface.js';
import { ObjControllerSubtypeIds, registerObjControllerSubtype } from './registry.js';

/**
 * Empty trailer — no fields. Modeled as `Record<string, never>` so the
 * registry's type parameter has something concrete (and biome-friendly).
 */
export type DetachAllRidersData = Record<string, never>;

export const DetachAllRidersKind = 'DetachAllRiders' as const;

export const DetachAllRidersDecoder = registerObjControllerSubtype<DetachAllRidersData>({
  kind: DetachAllRidersKind,
  subtypeId: ObjControllerSubtypeIds.CM_detachAllRidersForMount,
  encode(_stream: IByteStream, _data: DetachAllRidersData): void {},
  decode(_iter: IReadIterator): DetachAllRidersData {
    return {};
  },
});
