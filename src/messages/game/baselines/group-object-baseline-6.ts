/**
 * GroupObject baseline package 6 (BASELINES_SHARED_NP) — server-to-client.
 *
 * `GroupObject extends UniverseObject extends ServerObject`. A single
 * `GroupObject` instance is created when the first player invite is
 * accepted; it carries the membership roster, leader/loot-master pointers,
 * group level, and the optional "group pickup" rendezvous data.
 *
 * GroupObject has NO `addSharedVariable` (SHARED package) declarations —
 * every shared-with-clients field is `addSharedVariable_np` (SHARED_NP).
 * UniverseObject contributes nothing of its own. ServerObject contributes
 * 2 `_np` fields (`m_authServerProcessId`, `m_descriptionStringId`).
 *
 * Member order (from `Packager.cpp::GroupObject::addMembersToPackages`
 * lines 214-230, filtered to `addSharedVariable_np` only, after the 2
 * ServerObject `_np` fields):
 *
 *   ServerObject::addSharedVariable_np order (2 fields):
 *     [u32]                          m_authServerProcessId
 *     [StringId]                     m_descriptionStringId
 *
 *   GroupObject::addSharedVariable_np order (9 fields):
 *     [AutoDeltaVector<GroupMember>]            m_groupMembers
 *     [AutoDeltaVector<GroupShipFormation>]     m_groupShipFormationMembers
 *     [AutoDeltaVariable<std::string>]          m_groupName
 *     [AutoDeltaVariable<i16>]                  m_groupLevel
 *     [AutoDeltaVariable<u32>]                  m_formationNameCrc
 *     [AutoDeltaVariableObserver<NetworkId>]    m_lootMaster
 *     [AutoDeltaVariable<u32>]                  m_lootRule
 *     [AutoDeltaVariable<pair<i32,i32>>]        m_groupPickupTimer
 *     [AutoDeltaVariable<pair<string,Vector>>]  m_groupPickupLocation
 *
 *   Where:
 *     GroupMember = std::pair<NetworkId, std::string>           (id, name)
 *     GroupShipFormation = std::pair<NetworkId, i32>            (shipId, slot)
 *
 * Total: 11 members.
 *
 * Source:
 *   /home/tharper/code/swg-main/src/engine/server/library/serverGame/src/shared/generated/Packager.cpp
 *   lines 214-230 (GroupObject) and 557-591 (ServerObject)
 *
 *   GroupObject field types declared at:
 *   /home/tharper/code/swg-main/src/engine/server/library/serverGame/src/shared/object/GroupObject.h:141-154
 *
 *   IFF tag at:
 *   /home/tharper/code/swg-main/src/engine/server/library/serverGame/src/shared/objectTemplate/ServerGroupObjectTemplate.h
 *   (ServerGroupObjectTemplate_tag = TAG(G,R,U,P))
 */

import type { IReadIterator } from '../../../archive/interface.js';
import { NetworkIdCodec } from '../../../archive/network-id.js';
import { readStdString } from '../../../archive/string.js';
import { Vector3Codec } from '../../../archive/transform.js';
import type { NetworkId, Vector3 } from '../../../types.js';
import { readAndCheckMemberCount } from './auto-byte-stream.js';
import { readAutoDeltaVector } from './auto-delta-codecs.js';
import { BaselinePackageIds, ObjectTypeTags, registerBaseline } from './registry.js';
import { StringIdCodec, type StringIdValue } from './string-id.js';

/**
 * One entry in `m_groupMembers`. The leader is always index 0 (see
 * `GroupObject::getGroupLeaderId` / `::makeLeader` — the rotation is done
 * in-place so the leader sits at the front of the vector).
 */
export interface GroupMemberEntry {
  /** The member's CREO NetworkId. */
  id: NetworkId;
  /** The member's display name (UTF-8 `std::string`, NOT a Unicode string). */
  name: string;
}

/** One entry in `m_groupShipFormationMembers`. */
export interface GroupShipFormationEntry {
  /** The ship's NetworkId; `0n` if the member isn't piloting. */
  shipId: NetworkId;
  /** Formation slot index. */
  formationSlot: number;
}

/**
 * `m_groupPickupTimer` — `<startTime_t, endTime_t>`. If `endTime < now()`
 * there is no active group-pickup window.
 */
export interface GroupPickupTimer {
  startTime: number;
  endTime: number;
}

/**
 * `m_groupPickupLocation` — `<planetName, Vector(x,y,z)>` of the
 * group-pickup rendezvous spot. Empty planet name = unset.
 */
export interface GroupPickupLocation {
  planetName: string;
  position: Vector3;
}

export interface GroupObjectSharedNpBaseline {
  // From ServerObject SHARED_NP
  authServerProcessId: number;
  descriptionStringId: StringIdValue;
  // From GroupObject SHARED_NP
  /** Roster. `members[0]` is the leader. */
  members: GroupMemberEntry[];
  /** Per-member ship formation assignments (parallel to `members` when in space). */
  shipFormationMembers: GroupShipFormationEntry[];
  /** Group-chat-room display name (often empty for default-named groups). */
  groupName: string;
  /** Highest level among PC members; `0` for newly-formed groups. */
  groupLevel: number;
  /** Crc of the current group formation name (`Crc::crcNull` when no formation set). */
  formationNameCrc: number;
  /** Loot-master NetworkId; defaults to the leader. */
  lootMaster: NetworkId;
  /** Loot-rule enum (`0=FreeForAll`, server-defined enum). */
  lootRule: number;
  pickupTimer: GroupPickupTimer;
  pickupLocation: GroupPickupLocation;
}

export const GroupObjectSharedNpKind = 'GroupObjectSharedNp' as const;

const EXPECTED_MEMBER_COUNT = 11;

export const GroupObjectSharedNpDecoder = registerBaseline<GroupObjectSharedNpBaseline>({
  kind: GroupObjectSharedNpKind,
  typeId: ObjectTypeTags.GRUP,
  packageId: BaselinePackageIds.SHARED_NP,
  expectedMemberCount: EXPECTED_MEMBER_COUNT,
  decode(iter: IReadIterator): GroupObjectSharedNpBaseline {
    readAndCheckMemberCount(iter, EXPECTED_MEMBER_COUNT);
    // ServerObject section
    const authServerProcessId = iter.readU32();
    const descriptionStringId = StringIdCodec.decode(iter);
    // GroupObject section
    const members = readAutoDeltaVector(iter, (i): GroupMemberEntry => {
      const id = NetworkIdCodec.decode(i);
      const name = readStdString(i);
      return { id, name };
    });
    const shipFormationMembers = readAutoDeltaVector(iter, (i): GroupShipFormationEntry => {
      const shipId = NetworkIdCodec.decode(i);
      const formationSlot = i.readI32();
      return { shipId, formationSlot };
    });
    const groupName = readStdString(iter);
    const groupLevel = iter.readI16();
    const formationNameCrc = iter.readU32();
    const lootMaster = NetworkIdCodec.decode(iter);
    const lootRule = iter.readU32();
    const pickupTimer: GroupPickupTimer = {
      startTime: iter.readI32(),
      endTime: iter.readI32(),
    };
    const pickupLocation: GroupPickupLocation = {
      planetName: readStdString(iter),
      position: Vector3Codec.decode(iter),
    };
    return {
      authServerProcessId,
      descriptionStringId,
      members,
      shipFormationMembers,
      groupName,
      groupLevel,
      formationNameCrc,
      lootMaster,
      lootRule,
      pickupTimer,
      pickupLocation,
    };
  },
});
