/**
 * CreatureObject baseline package 6 (BASELINES_SHARED_NP) — server-to-client.
 *
 * The "SHARED_NP" baseline is sent to ALL clients observing the object but
 * is NOT persisted to the database (transient state like "what you're
 * looking at right now", "what mood you're in", current group, etc.).
 *
 * Member order (matches `Packager.cpp::ServerObject::addMembersToPackages`,
 * then `TangibleObject::addMembersToPackages`, then
 * `CreatureObject::addMembersToPackages`):
 *
 *   ServerObject::addSharedVariable_np order (2 fields):
 *     [u32]            m_authServerProcessId
 *     [StringId]       m_descriptionStringId
 *
 *   TangibleObject::addSharedVariable_np order (6 fields):
 *     [u8 bool]        m_inCombat
 *     [AutoDeltaSet<NetworkId>] m_passiveRevealPlayerCharacter
 *     [u32]            m_mapColorOverride
 *     [AutoDeltaSet<NetworkId>] m_accessList
 *     [AutoDeltaSet<i32>] m_guildAccessList
 *     [AutoDeltaMap<string, pair<string, pair<string, pair<Vector,float>>>>] m_effectsMap
 *
 *   CreatureObject::addSharedVariable_np order (27 fields):
 *     [i16]            m_level
 *     [i32]            m_levelHealthGranted
 *     [std::string]    m_animatingSkillData
 *     [std::string]    m_animationMood
 *     [NetworkId i64]  m_currentWeapon          (CachedNetworkId — same wire as NetworkId)
 *     [NetworkId i64]  m_group                  (CachedNetworkId)
 *     [pair<pair<NetworkId, string>, NetworkId>] m_groupInviter (PlayerAndShipPair)
 *     [i32]            m_guildId
 *     [NetworkId i64]  m_lookAtTarget
 *     [NetworkId i64]  m_intendedTarget
 *     [u8]             m_mood
 *     [i32]            m_performanceStartTime
 *     [i32]            m_performanceType
 *     [AutoDeltaVector<int>] m_totalAttributes  (Attributes::Value = int)
 *     [AutoDeltaVector<int>] m_totalMaxAttributes
 *     [AutoDeltaVector<WearableEntry>] m_wearableData
 *     [std::string]    m_alternateAppearanceSharedObjectTemplateName
 *     [u8 bool]        m_coverVisibility
 *     [AutoDeltaMap<u32, Buff::PackedBuff>] m_buffs
 *     [u8 bool]        m_clientUsesAnimationLocomotion
 *     [u8]             m_difficulty
 *     [i32]            m_hologramType
 *     [u8 bool]        m_visibleOnMapAndRadar
 *     [u8 bool]        m_isBeast
 *     [u8 bool]        m_forceShowHam
 *     [AutoDeltaVector<WearableEntry>] m_wearableAppearanceData
 *     [NetworkId i64]  m_decoyOrigin
 *
 * Total: 35 members (2 + 6 + 27).
 *
 * Source:
 *   /home/tharper/code/swg-main/src/engine/server/library/serverGame/src/shared/generated/Packager.cpp
 *   lines 156-182 (CreatureObject — 27 SHARED_NP lines)
 *   lines 718-723 (TangibleObject — 6 SHARED_NP lines)
 *   lines 589-590 (ServerObject — 2 SHARED_NP lines)
 *
 * Source for types:
 *   /home/tharper/code/swg-main/src/engine/server/library/serverGame/src/shared/object/CreatureObject.h:172
 *     (PlayerAndShipPair typedef)
 *   /home/tharper/code/swg-main/src/engine/shared/library/sharedGame/src/shared/object/Buff.h:20-30
 *     (Buff::PackedBuff struct)
 *   /home/tharper/code/swg-main/src/engine/shared/library/sharedGame/src/shared/core/WearableEntry.h
 *     (WearableEntry struct + Archive)
 */

import type { IReadIterator } from '../../../archive/interface.js';
import { NetworkIdCodec } from '../../../archive/network-id.js';
import { readStdString } from '../../../archive/string.js';
import type { NetworkId, Vector3 } from '../../../types.js';
import { readAndCheckMemberCount } from './auto-byte-stream.js';
import {
  readAutoDeltaMap,
  readAutoDeltaSetI32,
  readAutoDeltaSetNetworkId,
  readAutoDeltaVector,
  readAutoDeltaVectorI32,
} from './auto-delta-codecs.js';
import { PackedBuffCodec, type PackedBuffValue } from './packed-buff.js';
import { BaselinePackageIds, ObjectTypeTags, registerBaseline } from './registry.js';
import { StringIdCodec, type StringIdValue } from './string-id.js';
import { type WearableEntryValue, readWearableEntry } from './wearable-entry.js';

/**
 * `PlayerAndShipPair` = `std::pair<std::pair<NetworkId, std::string>, NetworkId>`.
 * Used for `m_groupInviter` — tracks "who invited you and from what ship".
 */
export interface PlayerAndShipPair {
  /** Inviter's NetworkId. */
  inviter: NetworkId;
  /** Inviter's name (cached for display). */
  inviterName: string;
  /** Inviter's ship NetworkId; `0n` if not on a ship. */
  ship: NetworkId;
}

/** Effect map entry (same shape as on TangibleObject p6). */
export interface CreatureObjectEffect {
  name: string;
  effectScript: string;
  hardpoint: string;
  offset: Vector3;
  scale: number;
}

export interface CreatureObjectSharedNpBaseline {
  // From ServerObject
  authServerProcessId: number;
  descriptionStringId: StringIdValue;
  // From TangibleObject
  inCombat: boolean;
  passiveRevealPlayerCharacter: NetworkId[];
  mapColorOverride: number;
  accessList: NetworkId[];
  guildAccessList: number[];
  effects: CreatureObjectEffect[];
  // From CreatureObject
  level: number;
  levelHealthGranted: number;
  animatingSkillData: string;
  animationMood: string;
  currentWeapon: NetworkId;
  group: NetworkId;
  groupInviter: PlayerAndShipPair;
  guildId: number;
  lookAtTarget: NetworkId;
  intendedTarget: NetworkId;
  /** Mood enum (smiling, angry, etc.). Stored as uint8 in C++. */
  mood: number;
  performanceStartTime: number;
  performanceType: number;
  /** Current attributes (Health, Constitution, Action, Stamina, Mind, Willpower). */
  totalAttributes: number[];
  /** Max attributes after all mods applied. */
  totalMaxAttributes: number[];
  /** Items worn in the standard equipment slots. */
  wearableData: WearableEntryValue[];
  /** Server template name for an alternate appearance; empty if not overridden. */
  alternateAppearanceSharedObjectTemplateName: string;
  /** True if the creature is still visible while in cover. */
  coverVisibility: boolean;
  /** Active buffs keyed by buff-name CRC. */
  buffs: { buffNameCrc: number; buff: PackedBuffValue }[];
  /** Client uses anim-system locomotion (vs server-driven). */
  clientUsesAnimationLocomotion: boolean;
  difficulty: number;
  hologramType: number;
  /** True if visible to map/radar overlays. */
  visibleOnMapAndRadar: boolean;
  isBeast: boolean;
  /** True to force the HAM bar to show. */
  forceShowHam: boolean;
  /** Items in the "appearance" tab (purely visual, no stats). */
  wearableAppearanceData: WearableEntryValue[];
  /** For decoy creatures, the original creature's NetworkId. `0n` if not a decoy. */
  decoyOrigin: NetworkId;
}

export const CreatureObjectSharedNpKind = 'CreatureObjectSharedNp' as const;

const EXPECTED_MEMBER_COUNT = 35;

/**
 * `PlayerAndShipPair` reader.
 *
 * The C++ pack of `pair<pair<NetworkId, string>, NetworkId>` is the
 * concatenation of all three fields in order — no length prefix.
 */
function readPlayerAndShipPair(iter: IReadIterator): PlayerAndShipPair {
  const inviter = NetworkIdCodec.decode(iter);
  const inviterName = readStdString(iter);
  const ship = NetworkIdCodec.decode(iter);
  return { inviter, inviterName, ship };
}

/**
 * Reader for the `m_effectsMap` value — `pair<string, pair<string, pair<Vector, float>>>`.
 */
function readEffectMapValue(iter: IReadIterator): {
  effectScript: string;
  hardpoint: string;
  offset: Vector3;
  scale: number;
} {
  const effectScript = readStdString(iter);
  const hardpoint = readStdString(iter);
  const x = iter.readF32();
  const y = iter.readF32();
  const z = iter.readF32();
  const scale = iter.readF32();
  return { effectScript, hardpoint, offset: { x, y, z }, scale };
}

export const CreatureObjectSharedNpDecoder = registerBaseline<CreatureObjectSharedNpBaseline>({
  kind: CreatureObjectSharedNpKind,
  typeId: ObjectTypeTags.CREO,
  packageId: BaselinePackageIds.SHARED_NP,
  expectedMemberCount: EXPECTED_MEMBER_COUNT,
  decode(iter: IReadIterator): CreatureObjectSharedNpBaseline {
    readAndCheckMemberCount(iter, EXPECTED_MEMBER_COUNT);
    // ServerObject section
    const authServerProcessId = iter.readU32();
    const descriptionStringId = StringIdCodec.decode(iter);
    // TangibleObject section
    const inCombat = iter.readBool();
    const passiveRevealPlayerCharacter = readAutoDeltaSetNetworkId(iter);
    const mapColorOverride = iter.readU32();
    const accessList = readAutoDeltaSetNetworkId(iter);
    const guildAccessList = readAutoDeltaSetI32(iter);
    const effects = readAutoDeltaMap(iter, readStdString, readEffectMapValue).map((entry) => ({
      name: entry.key,
      effectScript: entry.value.effectScript,
      hardpoint: entry.value.hardpoint,
      offset: entry.value.offset,
      scale: entry.value.scale,
    }));
    // CreatureObject section
    const level = iter.readI16();
    const levelHealthGranted = iter.readI32();
    const animatingSkillData = readStdString(iter);
    const animationMood = readStdString(iter);
    const currentWeapon = NetworkIdCodec.decode(iter);
    const group = NetworkIdCodec.decode(iter);
    const groupInviter = readPlayerAndShipPair(iter);
    const guildId = iter.readI32();
    const lookAtTarget = NetworkIdCodec.decode(iter);
    const intendedTarget = NetworkIdCodec.decode(iter);
    const mood = iter.readU8();
    const performanceStartTime = iter.readI32();
    const performanceType = iter.readI32();
    const totalAttributes = readAutoDeltaVectorI32(iter);
    const totalMaxAttributes = readAutoDeltaVectorI32(iter);
    const wearableData = readAutoDeltaVector(iter, readWearableEntry);
    const alternateAppearanceSharedObjectTemplateName = readStdString(iter);
    const coverVisibility = iter.readBool();
    const buffs = readAutoDeltaMap(iter, (i) => i.readU32(), PackedBuffCodec.decode).map((e) => ({
      buffNameCrc: e.key,
      buff: e.value,
    }));
    const clientUsesAnimationLocomotion = iter.readBool();
    const difficulty = iter.readU8();
    const hologramType = iter.readI32();
    const visibleOnMapAndRadar = iter.readBool();
    const isBeast = iter.readBool();
    const forceShowHam = iter.readBool();
    const wearableAppearanceData = readAutoDeltaVector(iter, readWearableEntry);
    const decoyOrigin = NetworkIdCodec.decode(iter);
    return {
      authServerProcessId,
      descriptionStringId,
      inCombat,
      passiveRevealPlayerCharacter,
      mapColorOverride,
      accessList,
      guildAccessList,
      effects,
      level,
      levelHealthGranted,
      animatingSkillData,
      animationMood,
      currentWeapon,
      group,
      groupInviter,
      guildId,
      lookAtTarget,
      intendedTarget,
      mood,
      performanceStartTime,
      performanceType,
      totalAttributes,
      totalMaxAttributes,
      wearableData,
      alternateAppearanceSharedObjectTemplateName,
      coverVisibility,
      buffs,
      clientUsesAnimationLocomotion,
      difficulty,
      hologramType,
      visibleOnMapAndRadar,
      isBeast,
      forceShowHam,
      wearableAppearanceData,
      decoyOrigin,
    };
  },
});
