/**
 * DefenderStatus (CM_setCombatTarget = 386) — server-to-client (auth-server
 * routed).
 *
 * Sent when a creature's combat target changes — the actor's NetworkId
 * is in the parent ObjControllerMessage header (`networkId`), and the
 * trailer is just the target NetworkId. `0n` means "drop target / out of
 * combat".
 *
 * Registered via the generic `packNetworkId / unpackNetworkId` helpers
 * (SetupServerNetworkMessages.cpp:1362), so the trailer is literally one
 * NetworkId — an i64 LE.
 *
 * For multi-target updates (rare; PvP only on most templates) the server
 * uses `CM_setCombatTargets` (419) with a `vector<NetworkId>` instead;
 * that's a separate subtype not modeled here.
 *
 * Wire layout (trailer only):
 *   [NetworkId (i64 LE)]   targetId          (0 = no target)
 *
 * Source:
 *   /home/tharper/code/swg-main/src/engine/server/library/serverNetworkMessages/src/shared/core/SetupServerNetworkMessages.cpp:100-113  (packNetworkId)
 *   /home/tharper/code/swg-main/src/engine/server/library/serverNetworkMessages/src/shared/core/SetupServerNetworkMessages.cpp:1362
 */

import type { IByteStream, IReadIterator } from '../../../archive/interface.js';
import { NetworkIdCodec } from '../../../archive/network-id.js';
import type { NetworkId } from '../../../types.js';
import { ObjControllerSubtypeIds, registerObjControllerSubtype } from './registry.js';

export interface DefenderStatusData {
  /** The new combat target NetworkId. `0n` ⇒ drop target / out of combat. */
  targetId: NetworkId;
}

export const DefenderStatusKind = 'DefenderStatus' as const;

export const DefenderStatusDecoder = registerObjControllerSubtype<DefenderStatusData>({
  kind: DefenderStatusKind,
  subtypeId: ObjControllerSubtypeIds.CM_setCombatTarget,
  encode(stream: IByteStream, data: DefenderStatusData): void {
    NetworkIdCodec.encode(stream, data.targetId);
  },
  decode(iter: IReadIterator): DefenderStatusData {
    return { targetId: NetworkIdCodec.decode(iter) };
  },
});
