/**
 * CreatureObject DELTAS_SHARED_NP (packageId 6) — server-to-client.
 *
 * Delta counterpart to `CreatureObjectSharedNpDecoder` (the baseline
 * decoder for the same `(typeId, packageId)` pair). This is the
 * single most heavily-trafficked delta package on a creature: mood,
 * posture-driven animation, group membership, look-at/intended target,
 * current weapon, HAM totals, worn items, and the entire active-buff
 * map all live here. Just about every actor-visible state change in
 * the world that ISN'T a position update lands as one of these deltas.
 *
 * Field order (matches `CreatureObjectSharedNpBaseline.decode()` 1:1):
 *
 *   ServerObject (2):
 *     0  authServerProcessId               u32
 *     1  descriptionStringId               StringId
 *
 *   TangibleObject (6):
 *     2  inCombat                          u8 bool
 *     3  passiveRevealPlayerCharacter      AutoDeltaSet<NetworkId>
 *     4  mapColorOverride                  u32
 *     5  accessList                        AutoDeltaSet<NetworkId>
 *     6  guildAccessList                   AutoDeltaSet<i32>
 *     7  effects                           AutoDeltaMap<string, pair<string, pair<string, pair<Vector, float>>>>
 *
 *   CreatureObject (27):
 *     8  level                             i16
 *     9  levelHealthGranted                i32
 *     10 animatingSkillData                std::string
 *     11 animationMood                     std::string
 *     12 currentWeapon                     NetworkId
 *     13 group                             NetworkId
 *     14 groupInviter                      PlayerAndShipPair (NOT AutoDelta — inline pair)
 *     15 guildId                           i32
 *     16 lookAtTarget                      NetworkId
 *     17 intendedTarget                    NetworkId
 *     18 mood                              u8
 *     19 performanceStartTime              i32
 *     20 performanceType                   i32
 *     21 totalAttributes                   AutoDeltaVector<i32>
 *     22 totalMaxAttributes                AutoDeltaVector<i32>
 *     23 wearableData                      AutoDeltaVector<WearableEntry>
 *     24 alternateAppearanceSharedObjectTemplateName  std::string
 *     25 coverVisibility                   u8 bool
 *     26 buffs                             AutoDeltaMap<u32, Buff::PackedBuff>
 *     27 clientUsesAnimationLocomotion     u8 bool
 *     28 difficulty                        u8
 *     29 hologramType                      i32
 *     30 visibleOnMapAndRadar              u8 bool
 *     31 isBeast                           u8 bool
 *     32 forceShowHam                      u8 bool
 *     33 wearableAppearanceData            AutoDeltaVector<WearableEntry>
 *     34 decoyOrigin                       NetworkId
 *
 * Total: 35 fields (2 + 6 + 27).
 *
 * Source for the field order:
 *   /home/tharper/code/swg-main/src/engine/server/library/serverGame/src/shared/generated/Packager.cpp
 *   lines 156-182 (CreatureObject SHARED_NP — 27 lines)
 *   lines 718-723 (TangibleObject SHARED_NP — 6 lines)
 *   lines 589-590 (ServerObject SHARED_NP — 2 lines)
 *
 * Non-obvious notes:
 *   - `groupInviter` (field 14) is **NOT** an AutoDelta. It's a plain
 *     `pair<pair<NetworkId, string>, NetworkId>` `AutoDeltaVariable`,
 *     so a delta on this field carries the full new tuple inline (no
 *     command framing). When the server clears the inviter it writes
 *     `(0n, "", 0n)`.
 *   - `effects` (field 7) is an `AutoDeltaMap` whose value is
 *     `pair<string, pair<string, pair<Vector, float>>>`. The wire
 *     layout for one value: [std::string effectScript][std::string
 *     hardpoint][f32 x][f32 y][f32 z][f32 scale] — no length prefix,
 *     no command byte at the value level (only at the outer map level).
 */

import type { IReadIterator } from '../../../archive/interface.js';
import { NetworkIdCodec } from '../../../archive/network-id.js';
import { readStdString } from '../../../archive/string.js';
import type { Vector3 } from '../../../types.js';
import {
  readAutoDeltaMapDelta,
  readAutoDeltaSetDelta,
  readAutoDeltaVectorDelta,
} from './auto-delta-delta-codecs.js';
import type {
  CreatureObjectSharedNpBaseline,
  PlayerAndShipPair,
} from './creature-object-baseline-6.js';
import { type DeltaPackageDecoder, registerDelta } from './delta-registry.js';
import { PackedBuffCodec } from './packed-buff.js';
import { BaselinePackageIds, ObjectTypeTags } from './registry.js';
import { StringIdCodec } from './string-id.js';
import { readWearableEntry } from './wearable-entry.js';

export const CreatureObjectSharedNpDeltaKind = 'CreatureObjectSharedNpDelta' as const;

/**
 * Reader for one `m_effectsMap` value:
 *   pair<string, pair<string, pair<Vector, float>>>
 *
 * Mirrors `creature-object-baseline-6.ts::readEffectMapValue`. The C++
 * pair packs concatenate without any framing — read in declaration order.
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

/**
 * Reader for `m_groupInviter` (PlayerAndShipPair) when it appears in a delta.
 *
 * `m_groupInviter` is an `AutoDeltaVariable<PlayerAndShipPair>` — a plain
 * value-typed AutoDelta, NOT a container. Its delta wire form is just the
 * full new value (no command-count header, no commands). The C++ side
 * `pack`s `pair<pair<NetworkId, string>, NetworkId>` as the concatenation
 * of all three fields in declaration order.
 *
 * Mirrors `creature-object-baseline-6.ts::readPlayerAndShipPair`.
 */
function readPlayerAndShipPair(iter: IReadIterator): PlayerAndShipPair {
  const inviter = NetworkIdCodec.decode(iter);
  const inviterName = readStdString(iter);
  const ship = NetworkIdCodec.decode(iter);
  return { inviter, inviterName, ship };
}

export const CreatureObjectSharedNpDeltaDecoder: DeltaPackageDecoder<CreatureObjectSharedNpBaseline> =
  registerDelta<CreatureObjectSharedNpBaseline>({
    kind: CreatureObjectSharedNpDeltaKind,
    typeId: ObjectTypeTags.CREO,
    packageId: BaselinePackageIds.SHARED_NP,
    fields: [
      // ---- ServerObject SHARED_NP (2 fields) ----
      { name: 'authServerProcessId', decode: (i) => i.readU32() },
      { name: 'descriptionStringId', decode: (i) => StringIdCodec.decode(i) },
      // ---- TangibleObject SHARED_NP (6 fields) ----
      { name: 'inCombat', decode: (i) => i.readBool() },
      {
        name: 'passiveRevealPlayerCharacter',
        decode: (i) => readAutoDeltaSetDelta(i, NetworkIdCodec.decode),
      },
      { name: 'mapColorOverride', decode: (i) => i.readU32() },
      {
        name: 'accessList',
        decode: (i) => readAutoDeltaSetDelta(i, NetworkIdCodec.decode),
      },
      {
        name: 'guildAccessList',
        decode: (i) => readAutoDeltaSetDelta(i, (j) => j.readI32()),
      },
      {
        name: 'effects',
        decode: (i) => readAutoDeltaMapDelta(i, readStdString, readEffectMapValue),
      },
      // ---- CreatureObject SHARED_NP (27 fields) ----
      { name: 'level', decode: (i) => i.readI16() },
      { name: 'levelHealthGranted', decode: (i) => i.readI32() },
      { name: 'animatingSkillData', decode: (i) => readStdString(i) },
      { name: 'animationMood', decode: (i) => readStdString(i) },
      { name: 'currentWeapon', decode: (i) => NetworkIdCodec.decode(i) },
      { name: 'group', decode: (i) => NetworkIdCodec.decode(i) },
      { name: 'groupInviter', decode: readPlayerAndShipPair },
      { name: 'guildId', decode: (i) => i.readI32() },
      { name: 'lookAtTarget', decode: (i) => NetworkIdCodec.decode(i) },
      { name: 'intendedTarget', decode: (i) => NetworkIdCodec.decode(i) },
      { name: 'mood', decode: (i) => i.readU8() },
      { name: 'performanceStartTime', decode: (i) => i.readI32() },
      { name: 'performanceType', decode: (i) => i.readI32() },
      {
        name: 'totalAttributes',
        decode: (i) => readAutoDeltaVectorDelta(i, (j) => j.readI32()),
      },
      {
        name: 'totalMaxAttributes',
        decode: (i) => readAutoDeltaVectorDelta(i, (j) => j.readI32()),
      },
      {
        name: 'wearableData',
        decode: (i) => readAutoDeltaVectorDelta(i, readWearableEntry),
      },
      { name: 'alternateAppearanceSharedObjectTemplateName', decode: (i) => readStdString(i) },
      { name: 'coverVisibility', decode: (i) => i.readBool() },
      {
        name: 'buffs',
        decode: (i) => readAutoDeltaMapDelta(i, (j) => j.readU32(), PackedBuffCodec.decode),
      },
      { name: 'clientUsesAnimationLocomotion', decode: (i) => i.readBool() },
      { name: 'difficulty', decode: (i) => i.readU8() },
      { name: 'hologramType', decode: (i) => i.readI32() },
      { name: 'visibleOnMapAndRadar', decode: (i) => i.readBool() },
      { name: 'isBeast', decode: (i) => i.readBool() },
      { name: 'forceShowHam', decode: (i) => i.readBool() },
      {
        name: 'wearableAppearanceData',
        decode: (i) => readAutoDeltaVectorDelta(i, readWearableEntry),
      },
      { name: 'decoyOrigin', decode: (i) => NetworkIdCodec.decode(i) },
    ],
  });
