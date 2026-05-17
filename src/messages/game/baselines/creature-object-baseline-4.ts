/**
 * CreatureObject baseline package 4 (BASELINES_CLIENT_SERVER_NP) — server-to-client.
 *
 * The "CLIENT_SERVER_NP" baseline is sent to the AUTH client (owner of the
 * object) only, and is NOT persisted to the database (transient owner-only
 * state). For a player CreatureObject this carries the live skill-mod map
 * (`m_modMap`) — the calculated skillMod stack used by every UI tooltip
 * the Windows client renders.
 *
 * Member order (matches `Packager.cpp::ServerObject::addMembersToPackages`,
 * then `TangibleObject::addMembersToPackages` (no fields), then
 * `CreatureObject::addMembersToPackages`):
 *
 *   ServerObject::addAuthClientServerVariable_np order (0 fields)
 *   TangibleObject::addAuthClientServerVariable_np order (0 fields)
 *
 *   CreatureObject::addAuthClientServerVariable_np order (16 fields):
 *     [f32]                                                  m_accelPercent
 *     [f32]                                                  m_accelScale
 *     [AutoDeltaVector<i32>]                                 m_attribBonus
 *     [AutoDeltaMap<string, pair<i32, i32>>]                 m_modMap
 *     [f32]                                                  m_movementPercent
 *     [f32]                                                  m_movementScale
 *     [NetworkId i64]                                        m_performanceListenTarget
 *     [f32]                                                  m_runSpeed
 *     [f32]                                                  m_slopeModAngle
 *     [f32]                                                  m_slopeModPercent
 *     [f32]                                                  m_turnScale
 *     [f32]                                                  m_walkSpeed
 *     [f32]                                                  m_waterModPercent
 *     [AutoDeltaSet<pair<NetworkId, NetworkId>>]             m_groupMissionCriticalObjectSet
 *     [AutoDeltaMap<string, i32>]                            m_commands
 *     [i32]                                                  m_totalLevelXp
 *
 * Total: 16 members.
 *
 * Source:
 *   /home/tharper/code/swg-main/src/engine/server/library/serverGame/src/shared/generated/Packager.cpp
 *   lines 183-198 (CreatureObject — 16 auth-client-np fields)
 *
 * Source for types:
 *   /home/tharper/code/swg-main/src/engine/server/library/serverGame/src/shared/object/CreatureObject.h:884-948
 */

import type { IReadIterator } from '../../../archive/interface.js';
import { NetworkIdCodec } from '../../../archive/network-id.js';
import { readStdString } from '../../../archive/string.js';
import type { NetworkId } from '../../../types.js';
import { readAndCheckMemberCount } from './auto-byte-stream.js';
import {
  readAutoDeltaMap,
  readAutoDeltaSetNetworkIdPair,
  readAutoDeltaVectorI32,
} from './auto-delta-codecs.js';
import { BaselinePackageIds, ObjectTypeTags, registerBaseline } from './registry.js';

/**
 * One entry in the calculated skill-mod map.
 *
 * `m_modMap` is `AutoDeltaMap<std::string, std::pair<int, int>>` where the
 * key is the mod name (e.g. `"pistol_accuracy"`, `"strength_modified"`,
 * `"slope_movement_percent"`) and the value pair is `(base, bonus)`:
 *   - `base`  = the base value derived from skills + species template
 *   - `bonus` = additive boost from worn items / active buffs
 *
 * The effective skillMod that the server uses for rolls is the sum
 * (`base + bonus`), clamped to ConfigSharedGame::getMaxCreatureSkillModBonus
 * for `bonus` (see `CreatureObject::getEnhancedModValue`). Consumers should
 * compute the total themselves; both halves are surfaced so a script can
 * tell skill-granted mods apart from gear/buff mods.
 */
export interface SkillModEntry {
  /** Mod name (e.g. `"pistol_accuracy"`). */
  name: string;
  /** Base value from skills + species (not modified by gear/buffs). */
  base: number;
  /** Additive bonus from worn items / active buffs. */
  bonus: number;
}

export interface CreatureObjectClientServerNpBaseline {
  // From CreatureObject (the only contributor — ServerObject + TangibleObject
  // add no fields to this package).
  accelPercent: number;
  accelScale: number;
  /** Bonus from items added to the max attribute values. One entry per Attributes::Enumerator slot. */
  attribBonus: number[];
  /** Calculated skill-mod map (e.g. `pistol_accuracy => {base: 75, bonus: 12}`). */
  modMap: SkillModEntry[];
  movementPercent: number;
  movementScale: number;
  performanceListenTarget: NetworkId;
  runSpeed: number;
  slopeModAngle: number;
  slopeModPercent: number;
  turnScale: number;
  walkSpeed: number;
  waterModPercent: number;
  /** Group-shared mission-critical objects: pair<groupMemberId, missionCriticalObjectId>. */
  groupMissionCriticalObjectSet: Array<{ first: NetworkId; second: NetworkId }>;
  /** Game commands the creature may execute (e.g. `"survey"` => skillLevel). */
  commands: Array<{ name: string; level: number }>;
  /** Total level XP — accumulator behind the displayed character level. */
  totalLevelXp: number;
}

export const CreatureObjectClientServerNpKind = 'CreatureObjectClientServerNp' as const;

const EXPECTED_MEMBER_COUNT = 16;

export const CreatureObjectClientServerNpDecoder =
  registerBaseline<CreatureObjectClientServerNpBaseline>({
    kind: CreatureObjectClientServerNpKind,
    typeId: ObjectTypeTags.CREO,
    packageId: BaselinePackageIds.CLIENT_SERVER_NP,
    expectedMemberCount: EXPECTED_MEMBER_COUNT,
    decode(iter: IReadIterator): CreatureObjectClientServerNpBaseline {
      readAndCheckMemberCount(iter, EXPECTED_MEMBER_COUNT);
      const accelPercent = iter.readF32();
      const accelScale = iter.readF32();
      const attribBonus = readAutoDeltaVectorI32(iter);
      const modMap = readAutoDeltaMap(
        iter,
        readStdString,
        (i): { base: number; bonus: number } => {
          // pair<int, int> packs as [i32 first][i32 second] with no length prefix.
          const base = i.readI32();
          const bonus = i.readI32();
          return { base, bonus };
        },
      ).map((entry) => ({
        name: entry.key,
        base: entry.value.base,
        bonus: entry.value.bonus,
      }));
      const movementPercent = iter.readF32();
      const movementScale = iter.readF32();
      const performanceListenTarget = NetworkIdCodec.decode(iter);
      const runSpeed = iter.readF32();
      const slopeModAngle = iter.readF32();
      const slopeModPercent = iter.readF32();
      const turnScale = iter.readF32();
      const walkSpeed = iter.readF32();
      const waterModPercent = iter.readF32();
      const groupMissionCriticalObjectSet = readAutoDeltaSetNetworkIdPair(iter);
      const commands = readAutoDeltaMap(iter, readStdString, (i) => i.readI32()).map((e) => ({
        name: e.key,
        level: e.value,
      }));
      const totalLevelXp = iter.readI32();
      return {
        accelPercent,
        accelScale,
        attribBonus,
        modMap,
        movementPercent,
        movementScale,
        performanceListenTarget,
        runSpeed,
        slopeModAngle,
        slopeModPercent,
        turnScale,
        walkSpeed,
        waterModPercent,
        groupMissionCriticalObjectSet,
        commands,
        totalLevelXp,
      };
    },
  });
