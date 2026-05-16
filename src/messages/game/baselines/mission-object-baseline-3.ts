/**
 * MissionObject baseline package 3 (BASELINES_SHARED) — server-to-client.
 *
 * `MissionObject extends IntangibleObject`. Mission instances live inside
 * the player's invisible "mission bag" inventory and the SHARED baseline
 * carries the human-facing browser-card data: difficulty, reward, target
 * info, location, etc. Mos Eisley terminals push 5-7 MissionObjects every
 * few minutes; populating one of these from the wire is the primary way to
 * present the mission browser UI to the player.
 *
 * Member order (matches `addSharedVariable()` order from
 * `Packager.cpp::ServerObject::addMembersToPackages` lines 570-573,
 * `IntangibleObject::addMembersToPackages` line 297, and
 * `MissionObject::addMembersToPackages` lines 340-355):
 *
 *   ServerObject::addSharedVariable order (4 fields):
 *     [f32 LE]            m_complexity
 *     [StringId]          m_nameStringId
 *     [Unicode::String]   m_objectName
 *     [i32 LE]            m_volume
 *
 *   IntangibleObject::addSharedVariable order (1 field):
 *     [i32 LE]            m_count
 *
 *   MissionObject::addSharedVariable order (12 fields):
 *     [i32 LE]            m_difficulty
 *     [Location]          m_endLocation
 *     [Unicode::String]   m_missionCreator
 *     [i32 LE]            m_reward
 *     [Location]          m_startLocation
 *     [u32 LE]            m_targetAppearance        (appearance template CRC)
 *     [StringId]          m_description
 *     [StringId]          m_title
 *     [i32 LE]            m_status
 *     [u32 LE]            m_missionType             (Mission type bitset; see MissionObject.cpp:309-444)
 *     [std::string]       m_targetName              (target template name, e.g. `object/mobile/...`)
 *     [Waypoint]          m_waypoint
 *
 * Total: 17 members.
 *
 * Source:
 *   /home/tharper/code/swg-main/src/engine/server/library/serverGame/src/shared/generated/Packager.cpp
 *   lines 295-308 (IntangibleObject) and 340-356 (MissionObject)
 *
 *   MissionObject field types declared at:
 *   /home/tharper/code/swg-main/src/engine/server/library/serverGame/src/shared/object/MissionObject.h:108-126
 *
 *   IFF tag at:
 *   /home/tharper/code/swg-main/src/engine/server/library/serverGame/src/shared/objectTemplate/ServerMissionObjectTemplate.h:33
 *   (ServerMissionObjectTemplate_tag = TAG(M,I,S,O))
 */

import type { IReadIterator } from '../../../archive/interface.js';
import { readStdString } from '../../../archive/string.js';
import { readUnicodeString } from '../../../archive/unicode-string.js';
import { readAndCheckMemberCount } from './auto-byte-stream.js';
import {
  LocationCodec,
  type LocationValue,
  WaypointCodec,
  type WaypointValue,
} from './location.js';
import { BaselinePackageIds, ObjectTypeTags, registerBaseline } from './registry.js';
import { StringIdCodec, type StringIdValue } from './string-id.js';

export interface MissionObjectSharedBaseline {
  // From ServerObject
  complexity: number;
  nameStringId: StringIdValue;
  objectName: string;
  volume: number;
  // From IntangibleObject
  count: number;
  // From MissionObject
  /** Mission difficulty (1..N; higher = tougher mobs / longer chains). */
  difficulty: number;
  /** Destination location for delivery / escort / patrol missions. */
  endLocation: LocationValue;
  /** Display name of the NPC who issued the mission (Unicode). */
  missionCreator: string;
  /** Credits paid on completion. */
  reward: number;
  /** Starting location (often the terminal itself for "go here, do thing"). */
  startLocation: LocationValue;
  /** CRC of the target's appearance template (e.g. an enemy mob). */
  targetAppearance: number;
  /** Mission description StringId (the body text in the browser). */
  description: StringIdValue;
  /** Mission title StringId (the headline shown in the browser list). */
  title: StringIdValue;
  /** Current status (0 = active, non-zero = various end states). */
  status: number;
  /**
   * Mission type bitset / index (see MissionObject.cpp:309-444 for the
   * mapping — destroy/recon/deliver/escort/bounty/survey/crafting/etc).
   */
  missionType: number;
  /** Server template name of the target (e.g. `object/mobile/...`). */
  targetName: string;
  /** Pinned waypoint for the mission's start (often the destination). */
  waypoint: WaypointValue;
}

export const MissionObjectSharedKind = 'MissionObjectShared' as const;

const EXPECTED_MEMBER_COUNT = 17;

export const MissionObjectSharedDecoder = registerBaseline<MissionObjectSharedBaseline>({
  kind: MissionObjectSharedKind,
  typeId: ObjectTypeTags.MISO,
  packageId: BaselinePackageIds.SHARED,
  expectedMemberCount: EXPECTED_MEMBER_COUNT,
  decode(iter: IReadIterator): MissionObjectSharedBaseline {
    readAndCheckMemberCount(iter, EXPECTED_MEMBER_COUNT);
    // ServerObject section
    const complexity = iter.readF32();
    const nameStringId = StringIdCodec.decode(iter);
    const objectName = readUnicodeString(iter);
    const volume = iter.readI32();
    // IntangibleObject section
    const count = iter.readI32();
    // MissionObject section
    const difficulty = iter.readI32();
    const endLocation = LocationCodec.decode(iter);
    const missionCreator = readUnicodeString(iter);
    const reward = iter.readI32();
    const startLocation = LocationCodec.decode(iter);
    const targetAppearance = iter.readU32();
    const description = StringIdCodec.decode(iter);
    const title = StringIdCodec.decode(iter);
    const status = iter.readI32();
    const missionType = iter.readU32();
    const targetName = readStdString(iter);
    const waypoint = WaypointCodec.decode(iter);
    return {
      complexity,
      nameStringId,
      objectName,
      volume,
      count,
      difficulty,
      endLocation,
      missionCreator,
      reward,
      startLocation,
      targetAppearance,
      description,
      title,
      status,
      missionType,
      targetName,
      waypoint,
    };
  },
});
