/**
 * WeaponObject baseline package 3 (BASELINES_SHARED) — server-to-client.
 *
 * The "SHARED" baseline is sent to ALL clients observing the object. For a
 * weapon, this carries the gameplay-visible stats: attack timing, accuracy,
 * range, and damage classification. NOTE: the min/max raw damage values
 * (`m_minDamage` / `m_maxDamage`) are `addServerVariable` — server-internal
 * only, NOT in the client baseline. Use `getAttributesBatch` (via
 * `ctx.fetchResourceAttributes`) to fetch them via `AttributeListMessage`
 * once the weapon is in inventory.
 *
 * Member order (matches `Packager.cpp::ServerObject::addMembersToPackages`
 * → `TangibleObject::addMembersToPackages` → `WeaponObject::addMembersToPackages`):
 *
 *   ServerObject::addSharedVariable (4 fields):
 *     [f32]                    m_complexity
 *     [StringId]               m_nameStringId
 *     [Unicode::String]        m_objectName
 *     [i32]                    m_volume
 *
 *   TangibleObject::addSharedVariable (9 fields):
 *     [i32]                    m_pvpFaction
 *     [i32]                    m_pvpType
 *     [string]                 m_appearanceData
 *     [AutoDeltaVector<NetworkId>] m_components
 *     [i32]                    m_condition
 *     [i32]                    m_count
 *     [i32]                    m_damageTaken
 *     [i32]                    m_maxHitPoints
 *     [bool]                   m_visible
 *
 *   WeaponObject::addSharedVariable (7 fields):
 *     [f32]                    m_attackSpeed
 *     [i32]                    m_accuracy
 *     [f32]                    m_minRange
 *     [f32]                    m_maxRange
 *     [i32]                    m_damageType
 *     [i32]                    m_elementalType
 *     [i32]                    m_elementalValue
 *
 * Total: 20 members (4 + 9 + 7).
 *
 * Source:
 *   /home/tharper/code/swg-main/src/engine/server/library/serverGame/src/shared/generated/Packager.cpp
 *   lines 557-591 (ServerObject), 691-724 (TangibleObject), 744-760 (WeaponObject)
 */

import type { IReadIterator } from '../../../archive/interface.js';
import { readStdString } from '../../../archive/string.js';
import { readUnicodeString } from '../../../archive/unicode-string.js';
import type { NetworkId } from '../../../types.js';
import { readAndCheckMemberCount } from './auto-byte-stream.js';
import { readAutoDeltaVector } from './auto-delta-codecs.js';
import { BaselinePackageIds, ObjectTypeTags, registerBaseline } from './registry.js';
import { NetworkIdCodec } from '../../../archive/network-id.js';
import { StringIdCodec, type StringIdValue } from './string-id.js';

export interface WeaponObjectSharedBaseline {
  // From ServerObject
  complexity: number;
  nameStringId: StringIdValue;
  objectName: string;
  volume: number;
  // From TangibleObject
  pvpFaction: number;
  pvpType: number;
  appearanceData: string;
  components: NetworkId[];
  condition: number;
  count: number;
  damageTaken: number;
  maxHitPoints: number;
  visible: boolean;
  // From WeaponObject
  /** Seconds between attacks (lower = faster). */
  attackSpeed: number;
  /** Base accuracy mod added to skill-based accuracy rolls. */
  accuracy: number;
  /** Minimum effective range in metres (closer than this incurs a penalty). */
  minRange: number;
  /** Maximum effective range in metres. */
  maxRange: number;
  /** Damage type enum (kinetic / energy / blast / etc.). */
  damageType: number;
  /** Elemental damage type (fire / acid / electricity / cold), 0 = none. */
  elementalType: number;
  /** Magnitude of the elemental damage component. */
  elementalValue: number;
}

export const WeaponObjectSharedKind = 'WeaponObjectShared' as const;

const EXPECTED_MEMBER_COUNT = 20;

export const WeaponObjectSharedDecoder = registerBaseline<WeaponObjectSharedBaseline>({
  kind: WeaponObjectSharedKind,
  typeId: ObjectTypeTags.WEAO,
  packageId: BaselinePackageIds.SHARED,
  expectedMemberCount: EXPECTED_MEMBER_COUNT,
  decode(iter: IReadIterator): WeaponObjectSharedBaseline {
    readAndCheckMemberCount(iter, EXPECTED_MEMBER_COUNT);
    // ServerObject
    const complexity = iter.readF32();
    const nameStringId = StringIdCodec.decode(iter);
    const objectName = readUnicodeString(iter);
    const volume = iter.readI32();
    // TangibleObject
    const pvpFaction = iter.readI32();
    const pvpType = iter.readI32();
    const appearanceData = readStdString(iter);
    const components = readAutoDeltaVector(iter, NetworkIdCodec.decode);
    const condition = iter.readI32();
    const count = iter.readI32();
    const damageTaken = iter.readI32();
    const maxHitPoints = iter.readI32();
    const visible = iter.readBool();
    // WeaponObject
    const attackSpeed = iter.readF32();
    const accuracy = iter.readI32();
    const minRange = iter.readF32();
    const maxRange = iter.readF32();
    const damageType = iter.readI32();
    const elementalType = iter.readI32();
    const elementalValue = iter.readI32();
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
      attackSpeed,
      accuracy,
      minRange,
      maxRange,
      damageType,
      elementalType,
      elementalValue,
    };
  },
});
