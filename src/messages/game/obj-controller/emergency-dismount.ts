/**
 * EmergencyDismount (CM_emergencyDismountForRider = 540) — server → server.
 *
 * Sent from the rider's authoritative server when the rider must be
 * emergency-dismounted (mount destroyed, mount left the rider's range, the
 * rider was teleported into an instance, etc.). The CreatureController on
 * the authoritative side performs the dismount in response.
 *
 * Wire layout (trailer only): EMPTY.
 *
 * Source:
 *   /home/tharper/code/swg-main/src/engine/server/library/serverGame/src/shared/object/CreatureObject_Mounts.cpp:1112  (sendControllerMessageToAuthServer(CM_emergencyDismountForRider, nullptr))
 *   /home/tharper/code/swg-main/src/engine/server/library/serverGame/src/shared/controller/CreatureController.cpp:827   (handler)
 */

import type { IByteStream, IReadIterator } from '../../../archive/interface.js';
import { ObjControllerSubtypeIds, registerObjControllerSubtype } from './registry.js';

/**
 * Empty trailer — no fields. Modeled as `Record<string, never>` so the
 * registry's type parameter has something concrete (and biome-friendly).
 */
export type EmergencyDismountData = Record<string, never>;

export const EmergencyDismountKind = 'EmergencyDismount' as const;

export const EmergencyDismountDecoder = registerObjControllerSubtype<EmergencyDismountData>({
  kind: EmergencyDismountKind,
  subtypeId: ObjControllerSubtypeIds.CM_emergencyDismountForRider,
  encode(_stream: IByteStream, _data: EmergencyDismountData): void {},
  decode(_iter: IReadIterator): EmergencyDismountData {
    return {};
  },
});
