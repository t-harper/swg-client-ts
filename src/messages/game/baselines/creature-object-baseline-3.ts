/**
 * CreatureObject baseline package 3 (BASELINES_SHARED) — server-to-client.
 *
 * The "SHARED" baseline is sent to ALL clients observing the object (not just
 * the auth client). For a creature, this is the publicly-visible state every
 * nearby player needs to render it: posture, scale, master id (for pets),
 * combat states, etc.
 *
 * CreatureObject extends TangibleObject extends ServerObject. The package
 * concatenates members in `addSharedVariable()` order across the three
 * classes' `addMembersToPackages` calls.
 *
 * Member order (matches `Packager.cpp::ServerObject::addMembersToPackages`,
 * then `TangibleObject::addMembersToPackages`, then
 * `CreatureObject::addMembersToPackages`):
 *
 *   ServerObject::addSharedVariable order (4 fields):
 *     [f32]            m_complexity
 *     [StringId]       m_nameStringId
 *     [Unicode::String] m_objectName
 *     [i32]            m_volume
 *
 *   TangibleObject::addSharedVariable order (9 fields):
 *     [u32]            m_pvpFaction
 *     [i32]            m_pvpType
 *     [std::string]    m_appearanceData
 *     [AutoDeltaSet<i32>] m_components
 *     [i32]            m_condition
 *     [i32]            m_count
 *     [i32]            m_damageTaken
 *     [i32]            m_maxHitPoints
 *     [u8 bool]        m_visible
 *
 *   CreatureObject::addSharedVariable order (6 fields):
 *     [i8]             m_posture          (Postures::Enumerator)
 *     [u8]             m_rank             (DEPRECATED — use PlayerObject::m_currentGcwRank)
 *     [NetworkId i64]  m_masterId         (creature's master for pets/etc., 0 if no master)
 *     [f32]            m_scaleFactor      (visual scale multiplier)
 *     [i32]            m_shockWounds      (accumulated shock wound damage)
 *     [u64]            m_states           (States:: bitmask — combat states like StateInCombat)
 *
 * Total: 19 members (4 + 9 + 6).
 *
 * Source:
 *   /home/tharper/code/swg-main/src/engine/server/library/serverGame/src/shared/generated/Packager.cpp
 *   lines 110-124 (CreatureObject — first 6 shared lines)
 *   lines 691-707 (TangibleObject — 9 shared lines)
 *   lines 570-573 (ServerObject — 4 shared lines)
 *
 * Source for types:
 *   /home/tharper/code/swg-main/src/engine/server/library/serverGame/src/shared/object/CreatureObject.h:842-889
 *   /home/tharper/code/swg-main/src/game/shared/library/swgSharedUtility/src/shared/Postures.def
 *     (`typedef int8 Enumerator`)
 */

import type { IReadIterator } from '../../../archive/interface.js';
import { NetworkIdCodec } from '../../../archive/network-id.js';
import { readStdString } from '../../../archive/string.js';
import { readUnicodeString } from '../../../archive/unicode-string.js';
import type { NetworkId } from '../../../types.js';
import { readAndCheckMemberCount } from './auto-byte-stream.js';
import { readAutoDeltaSetI32 } from './auto-delta-codecs.js';
import { BaselinePackageIds, ObjectTypeTags, registerBaseline } from './registry.js';
import { StringIdCodec, type StringIdValue } from './string-id.js';

export interface CreatureObjectSharedBaseline {
  // From ServerObject
  complexity: number;
  nameStringId: StringIdValue;
  objectName: string;
  volume: number;
  // From TangibleObject
  pvpFaction: number;
  pvpType: number;
  appearanceData: string;
  components: number[];
  condition: number;
  count: number;
  damageTaken: number;
  maxHitPoints: number;
  visible: boolean;
  // From CreatureObject
  /**
   * Postures::Enumerator (i8). Values: -1 Invalid, 0 Upright, 1 Crouched,
   * 2 Prone, 3 Sneaking, 4 Blocking, 5 Climbing, 6 Flying, 7 LyingDown,
   * 8 Sitting, 9 SkillAnimating, 10 DrivingVehicle, 11 RidingCreature,
   * 12 KnockedDown, 13 Incapacitated, 14 Dead.
   */
  posture: number;
  /** DEPRECATED — use PlayerObject::currentGcwRank instead. 0 = no rank designated. */
  rank: number;
  /** For pets/owned creatures, the owner's NetworkId. `0n` if no master. */
  masterId: NetworkId;
  /** Visual scale multiplier; 1.0 = default size. */
  scaleFactor: number;
  /** Accumulated shock wound damage (special-ability pool damage). */
  shockWounds: number;
  /**
   * 64-bit bitmask of active combat states (States::* enum: StateInCombat,
   * StateMounted, StateRiding, etc.). Use bit operations against the C++
   * State bit positions.
   */
  states: bigint;
}

export const CreatureObjectSharedKind = 'CreatureObjectShared' as const;

const EXPECTED_MEMBER_COUNT = 19;

export const CreatureObjectSharedDecoder = registerBaseline<CreatureObjectSharedBaseline>({
  kind: CreatureObjectSharedKind,
  typeId: ObjectTypeTags.CREO,
  packageId: BaselinePackageIds.SHARED,
  expectedMemberCount: EXPECTED_MEMBER_COUNT,
  decode(iter: IReadIterator): CreatureObjectSharedBaseline {
    readAndCheckMemberCount(iter, EXPECTED_MEMBER_COUNT);
    // ServerObject section
    const complexity = iter.readF32();
    const nameStringId = StringIdCodec.decode(iter);
    const objectName = readUnicodeString(iter);
    const volume = iter.readI32();
    // TangibleObject section
    const pvpFaction = iter.readU32();
    const pvpType = iter.readI32();
    const appearanceData = readStdString(iter);
    const components = readAutoDeltaSetI32(iter);
    const condition = iter.readI32();
    const count = iter.readI32();
    const damageTaken = iter.readI32();
    const maxHitPoints = iter.readI32();
    const visible = iter.readBool();
    // CreatureObject section
    const posture = iter.readI8();
    const rank = iter.readU8();
    const masterId = NetworkIdCodec.decode(iter);
    const scaleFactor = iter.readF32();
    const shockWounds = iter.readI32();
    const states = iter.readU64();
    return {
      complexity,
      nameStringId,
      objectName,
      volume,
      pvpFaction,
      pvpType,
      appearanceData,
      components,
      condition,
      count,
      damageTaken,
      maxHitPoints,
      visible,
      posture,
      rank,
      masterId,
      scaleFactor,
      shockWounds,
      states,
    };
  },
});
