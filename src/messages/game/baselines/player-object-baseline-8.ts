/**
 * PlayerObject baseline package 8 (BASELINES_FIRST_PARENT_CLIENT_SERVER) —
 * server-to-client.
 *
 * The "FIRST_PARENT_CLIENT_SERVER" baseline is sent to the AUTH client of
 * the object's FIRST_PARENT (root container). For a PlayerObject living
 * inside a player's CreatureObject, that's the player themselves. PLAY p8
 * carries the persistent, owner-only "personality" half of a character:
 * earned XP per category, waypoint book, Force power, quest book, and the
 * currently-selected NGE roadmap working skill.
 *
 * Member order (matches `Packager.cpp::PlayerObject::addMembersToPackages`,
 * the only contributor to this package):
 *
 *   PlayerObject::addFirstParentAuthClientServerVariable order (9 fields):
 *     [AutoDeltaMap<string, i32>]              m_experiencePoints
 *     [AutoDeltaMap<NetworkId, Waypoint>]      m_waypoints
 *     [i32]                                    m_forcePower
 *     [i32]                                    m_maxForcePower
 *     [BitArray]                               m_completedQuests
 *     [BitArray]                               m_activeQuests
 *     [u32]                                    m_currentQuest
 *     [AutoDeltaPackedMap<u32, PlayerQuestData>] m_quests   (wire == AutoDeltaMap)
 *     [string]                                 m_workingSkill
 *
 * Total: 9 members. ServerObject + IntangibleObject contribute 0 fields to
 * the FIRST_PARENT_CLIENT_SERVER package.
 *
 * Source:
 *   /home/tharper/code/swg-main/src/engine/server/library/serverGame/src/shared/generated/Packager.cpp
 *   lines 456-464 (PlayerObject — 9 first-parent-client-server lines)
 *
 * Source for types:
 *   /home/tharper/code/swg-main/src/engine/server/library/serverGame/src/shared/object/PlayerObject.h
 *   /home/tharper/code/swg-main/src/engine/shared/library/sharedGame/src/shared/quest/PlayerQuestData.cpp:236-254
 *     (PlayerQuestData wire layout)
 */

import type { IReadIterator } from '../../../archive/interface.js';
import { NetworkIdCodec } from '../../../archive/network-id.js';
import { readStdString } from '../../../archive/string.js';
import type { NetworkId } from '../../../types.js';
import { readAndCheckMemberCount } from './auto-byte-stream.js';
import {
  type BitArrayValue,
  readAutoDeltaMap,
  readBitArray,
} from './auto-delta-codecs.js';
import { type WaypointValue, WaypointCodec } from './location.js';
import { BaselinePackageIds, ObjectTypeTags, registerBaseline } from './registry.js';

/**
 * One entry in a player's quest book.
 *
 * The packed map keys quests by their `questNameCrc` (u32). The value is a
 * `PlayerQuestData` struct whose wire form is:
 *   [NetworkId i64]   questGiver
 *   [u16]             activeTasks       (bitmask: bit N = task N is active)
 *   [u16]             completedTasks    (bitmask: bit N = task N is completed)
 *   [bool (u8)]       completed         (whole quest is complete)
 *   [u32]             relativeAgeIndex  (server-monotonic; lower = older)
 *   [bool (u8)]       hasReceivedReward
 */
export interface PlayerQuestEntry {
  /** CRC of the quest name (key into questlist datatable). */
  questCrc: number;
  /** NetworkId of the NPC who gave the quest. */
  questGiver: NetworkId;
  /** Bitmask: bit N = task N is currently active. */
  activeTasksMask: number;
  /** Bitmask: bit N = task N has been completed. */
  completedTasksMask: number;
  /** True once the whole quest is done. */
  completed: boolean;
  /** Server-monotonic insertion order; lower = older. */
  relativeAgeIndex: number;
  /** True once the reward has been claimed. */
  hasReceivedReward: boolean;
}

export interface PlayerObjectFirstParentClientServerBaseline {
  /** XP map: category name (e.g. `"combat_general"`) → cumulative XP earned. */
  experiencePoints: Array<{ category: string; amount: number }>;
  /** Waypoint book keyed by the waypoint's NetworkId. */
  waypoints: Array<{ id: NetworkId; waypoint: WaypointValue }>;
  /** Current Force pool (Jedi only). */
  forcePower: number;
  /** Max Force pool capacity (Jedi only). */
  maxForcePower: number;
  /** Bitset of all quests this character has ever completed. */
  completedQuests: BitArrayValue;
  /** Bitset of quests currently active in the player's quest book. */
  activeQuests: BitArrayValue;
  /** CRC of the quest the player has "tracked" in the HUD. 0 if none. */
  currentQuest: number;
  /** Per-quest progress map. */
  quests: PlayerQuestEntry[];
  /**
   * The NGE roadmap "working skill" — the skill the player is currently
   * earning XP toward (e.g. `"class_domestics_phase1_novice"`). Set by the
   * roadmap UI; the server uses it to filter which `expModified` updates
   * fire XP grants. Empty string when no roadmap skill is selected.
   */
  workingSkill: string;
}

export const PlayerObjectFirstParentClientServerKind =
  'PlayerObjectFirstParentClientServer' as const;

const EXPECTED_MEMBER_COUNT = 9;

function readPlayerQuestData(iter: IReadIterator): {
  questGiver: NetworkId;
  activeTasksMask: number;
  completedTasksMask: number;
  completed: boolean;
  relativeAgeIndex: number;
  hasReceivedReward: boolean;
} {
  const questGiver = NetworkIdCodec.decode(iter);
  const activeTasksMask = iter.readU16();
  const completedTasksMask = iter.readU16();
  const completed = iter.readBool();
  const relativeAgeIndex = iter.readU32();
  const hasReceivedReward = iter.readBool();
  return {
    questGiver,
    activeTasksMask,
    completedTasksMask,
    completed,
    relativeAgeIndex,
    hasReceivedReward,
  };
}

export const PlayerObjectFirstParentClientServerDecoder =
  registerBaseline<PlayerObjectFirstParentClientServerBaseline>({
    kind: PlayerObjectFirstParentClientServerKind,
    typeId: ObjectTypeTags.PLAY,
    packageId: BaselinePackageIds.FIRST_PARENT_CLIENT_SERVER,
    expectedMemberCount: EXPECTED_MEMBER_COUNT,
    decode(iter: IReadIterator): PlayerObjectFirstParentClientServerBaseline {
      readAndCheckMemberCount(iter, EXPECTED_MEMBER_COUNT);
      const experiencePoints = readAutoDeltaMap(iter, readStdString, (i) => i.readI32()).map(
        (entry) => ({ category: entry.key, amount: entry.value }),
      );
      const waypoints = readAutoDeltaMap(iter, NetworkIdCodec.decode, WaypointCodec.decode).map(
        (entry) => ({ id: entry.key, waypoint: entry.value }),
      );
      const forcePower = iter.readI32();
      const maxForcePower = iter.readI32();
      const completedQuests = readBitArray(iter);
      const activeQuests = readBitArray(iter);
      const currentQuest = iter.readU32();
      // AutoDeltaPackedMap on the wire == AutoDeltaMap (the "packed" half is
      // an in-memory string buffer the server uses for DB persistence; the
      // packDelta/pack wire path is identical to AutoDeltaMap).
      const quests: PlayerQuestEntry[] = readAutoDeltaMap(
        iter,
        (i) => i.readU32(),
        readPlayerQuestData,
      ).map((entry) => ({
        questCrc: entry.key,
        ...entry.value,
      }));
      const workingSkill = readStdString(iter);
      return {
        experiencePoints,
        waypoints,
        forcePower,
        maxForcePower,
        completedQuests,
        activeQuests,
        currentQuest,
        quests,
        workingSkill,
      };
    },
  });
