/**
 * BuildingObject baseline package 3 (BASELINES_SHARED) — server-to-client.
 *
 * The "SHARED" baseline is sent to ALL clients observing the object. For
 * buildings, this carries the publicly-visible state — name, condition, pvp
 * metadata, etc. inherited from TangibleObject and ServerObject.
 *
 * `BuildingObject extends TangibleObject extends ServerObject`. The
 * `addMembersToPackages` for `BuildingObject` adds NO shared variables (all
 * persisted building state is server-only: `m_allowed`, `m_banned`,
 * `m_isPublic`, `m_maintenanceCost`, `m_timeLastChecked`, `m_cityId`,
 * `m_contentsLoaded`). So the SHARED baseline contents are identical to
 * `TangibleObject` SHARED — but the wire `typeId` is `BUIO` (the building
 * template tag), so it needs its own decoder registration to be queryable.
 *
 * Member order (inherited only — same as TangibleObject SHARED):
 *
 *   ServerObject::addSharedVariable order (4 fields):
 *     [f32 LE]         m_complexity        — crafting/manufacturing difficulty
 *     [StringId]       m_nameStringId      — localized name lookup
 *     [Unicode::String] m_objectName       — overridden display name (free text)
 *     [i32 LE]         m_volume            — volume taken by this object
 *
 *   TangibleObject::addSharedVariable order (9 fields):
 *     [u32 LE]         m_pvpFaction
 *     [i32 LE]         m_pvpType
 *     [std::string]    m_appearanceData
 *     [AutoDeltaSet<int>] m_components
 *     [i32 LE]         m_condition
 *     [i32 LE]         m_count
 *     [i32 LE]         m_damageTaken
 *     [i32 LE]         m_maxHitPoints
 *     [u8]             m_visible
 *
 * Total: 13 members (4 + 9 + 0).
 *
 * Source (member adds):
 *   /home/tharper/code/swg-main/src/engine/server/library/serverGame/src/shared/generated/Packager.cpp
 *   lines 557-591 (ServerObject), 691-724 (TangibleObject), 64-73 (BuildingObject)
 *
 * Source (BuildingObject class):
 *   /home/tharper/code/swg-main/src/engine/server/library/serverGame/src/shared/object/BuildingObject.{h,cpp}
 */

import type { IReadIterator } from '../../../archive/interface.js';
import { readStdString } from '../../../archive/string.js';
import { readUnicodeString } from '../../../archive/unicode-string.js';
import { readAndCheckMemberCount } from './auto-byte-stream.js';
import { readAutoDeltaSetI32 } from './auto-delta-codecs.js';
import { BaselinePackageIds, ObjectTypeTags, registerBaseline } from './registry.js';
import { StringIdCodec, type StringIdValue } from './string-id.js';

export interface BuildingObjectSharedBaseline {
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
}

export const BuildingObjectSharedKind = 'BuildingObjectShared' as const;

/**
 * Member count must match the sum of ServerObject's + TangibleObject's +
 * BuildingObject's shared variables — BuildingObject adds zero, so 13.
 */
const EXPECTED_MEMBER_COUNT = 13;

export const BuildingObjectSharedDecoder = registerBaseline<BuildingObjectSharedBaseline>({
  kind: BuildingObjectSharedKind,
  typeId: ObjectTypeTags.BUIO,
  packageId: BaselinePackageIds.SHARED,
  expectedMemberCount: EXPECTED_MEMBER_COUNT,
  decode(iter: IReadIterator): BuildingObjectSharedBaseline {
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
    };
  },
});
