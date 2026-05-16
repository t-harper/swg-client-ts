/**
 * GroupAccept (CM_setGroup = 421) — bidirectional auth-server routing.
 *
 * Used both by the invitee accepting a group invitation ("join this
 * group") and by anyone leaving / being kicked from a group ("set group
 * to none"). The wire payload is a `pair<bool, NetworkId>`:
 *   - `disbandingCurrentGroup` — `true` when the actor's *current* group
 *     should be disbanded as part of this transition; usually `false` for
 *     a plain accept.
 *   - `groupId` — the NetworkId of the group being joined. `0n` means
 *     "leave / no group", which is the wire shape of `/leaveGroup` and
 *     `/groupDisband`.
 *
 * Registered via the generic `packBoolNetworkId / unpackBoolNetworkId`
 * helpers (SetupServerNetworkMessages.cpp:1393), so the trailer is
 * literally a bool followed by an i64 LE NetworkId.
 *
 * GroupDecline doesn't have a distinct subtype: server-side it's handled
 * by clearing the inviter via `CM_setGroupInviter` with empty values, so
 * use `GroupInvite` with `inviterName=""`, `inviterId=0n` to model that.
 *
 * Wire layout (trailer only):
 *   [bool (1 byte)]       disbandingCurrentGroup
 *   [NetworkId (i64 LE)]  groupId             (0 = leave / no group)
 *
 * Source:
 *   /home/tharper/code/swg-main/src/engine/server/library/serverGame/src/shared/object/CreatureObject.cpp:5617  (sendControllerMessage call site)
 *   /home/tharper/code/swg-main/src/engine/server/library/serverNetworkMessages/src/shared/core/SetupServerNetworkMessages.cpp:388-402  (packBoolNetworkId)
 *   /home/tharper/code/swg-main/src/engine/server/library/serverNetworkMessages/src/shared/core/SetupServerNetworkMessages.cpp:1393
 */

import type { IByteStream, IReadIterator } from '../../../archive/interface.js';
import { NetworkIdCodec } from '../../../archive/network-id.js';
import type { NetworkId } from '../../../types.js';
import { ObjControllerSubtypeIds, registerObjControllerSubtype } from './registry.js';

export interface GroupAcceptData {
  /**
   * `true` ⇒ disband the actor's current group as part of this transition.
   * Usually `false` for a plain accept.
   */
  disbandingCurrentGroup: boolean;
  /** NetworkId of the group being joined. `0n` means "leave the current group". */
  groupId: NetworkId;
}

export const GroupAcceptKind = 'GroupAccept' as const;

export const GroupAcceptDecoder = registerObjControllerSubtype<GroupAcceptData>({
  kind: GroupAcceptKind,
  subtypeId: ObjControllerSubtypeIds.CM_setGroup,
  encode(stream: IByteStream, data: GroupAcceptData): void {
    stream.writeBool(data.disbandingCurrentGroup);
    NetworkIdCodec.encode(stream, data.groupId);
  },
  decode(iter: IReadIterator): GroupAcceptData {
    const disbandingCurrentGroup = iter.readBool();
    const groupId = NetworkIdCodec.decode(iter);
    return { disbandingCurrentGroup, groupId };
  },
});
