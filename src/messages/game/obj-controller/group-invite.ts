/**
 * GroupInvite (CM_setGroupInviter = 351) — server-to-client (forwarded
 * from the inviter's authoritative server to the invitee's auth server).
 *
 * Carries the data the invitee needs to display "Player X invited you to
 * a group" — the inviter's display name, NetworkId, and ship NetworkId
 * (for space POB-ship cases). A *clear* inviter (decline / timeout) is
 * sent as the same subtype with `inviterId == 0n` and `inviterName == ""`.
 *
 * Registered via `packStringNetworkIdNetworkId` (a `std::pair<std::string,
 * std::pair<NetworkId, NetworkId>>`) at SetupServerNetworkMessages.cpp:1336,
 * so the trailer is:
 *
 * Wire layout (trailer only):
 *   [std::string]            inviterName      display-name (UTF-8 bytes)
 *   [NetworkId (i64 LE)]     inviterId        NetworkId of the inviter (0 = clear)
 *   [NetworkId (i64 LE)]     inviterShipId    POB-ship id; 0 = ground / no ship
 *
 * Source:
 *   /home/tharper/code/swg-main/src/engine/server/library/serverGame/src/shared/object/CreatureObject.cpp:5655-5676  (setGroupInviter call site)
 *   /home/tharper/code/swg-main/src/engine/server/library/serverNetworkMessages/src/shared/core/SetupServerNetworkMessages.cpp:663-677  (packStringNetworkIdNetworkId)
 *   /home/tharper/code/swg-main/src/engine/server/library/serverNetworkMessages/src/shared/core/SetupServerNetworkMessages.cpp:1336
 */

import type { IByteStream, IReadIterator } from '../../../archive/interface.js';
import { NetworkIdCodec } from '../../../archive/network-id.js';
import { readStdString, writeStdString } from '../../../archive/string.js';
import type { NetworkId } from '../../../types.js';
import { ObjControllerSubtypeIds, registerObjControllerSubtype } from './registry.js';

export interface GroupInviteData {
  /** Display name of the inviter (e.g. "Han"). Empty when clearing the inviter. */
  inviterName: string;
  /** NetworkId of the inviter. `0n` when clearing (decline / timeout). */
  inviterId: NetworkId;
  /** NetworkId of the inviter's POB ship. `0n` for ground invites. */
  inviterShipId: NetworkId;
}

export const GroupInviteKind = 'GroupInvite' as const;

export const GroupInviteDecoder = registerObjControllerSubtype<GroupInviteData>({
  kind: GroupInviteKind,
  subtypeId: ObjControllerSubtypeIds.CM_setGroupInviter,
  encode(stream: IByteStream, data: GroupInviteData): void {
    writeStdString(stream, data.inviterName);
    NetworkIdCodec.encode(stream, data.inviterId);
    NetworkIdCodec.encode(stream, data.inviterShipId);
  },
  decode(iter: IReadIterator): GroupInviteData {
    const inviterName = readStdString(iter);
    const inviterId = NetworkIdCodec.decode(iter);
    const inviterShipId = NetworkIdCodec.decode(iter);
    return { inviterName, inviterId, inviterShipId };
  },
});
