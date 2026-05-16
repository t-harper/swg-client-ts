/**
 * TangibleObject baseline package 3 (BASELINES_SHARED) — server-to-client.
 *
 * The "SHARED" baseline is sent to ALL clients observing the object (not just
 * the auth client), so it carries the publicly-visible state: name, condition,
 * appearance, pvp metadata, etc. This is the baseline that lets nearby
 * players see your character's name, hit point bar, and faction colors.
 *
 * Member order (matches `addSharedVariable()` order in
 * `Packager.cpp::TangibleObject::addMembersToPackages` AND its parent
 * `Packager.cpp::ServerObject::addMembersToPackages`. The parent's
 * `addMembersToPackages` is called from ServerObject's ctor BEFORE
 * TangibleObject's runs, so ServerObject's shared variables come FIRST):
 *
 *   ServerObject::addSharedVariable order (4 fields):
 *     [f32 LE]         m_complexity        — crafting/manufacturing difficulty
 *     [StringId]       m_nameStringId      — localized name lookup
 *     [Unicode::String] m_objectName       — overridden display name (free text)
 *     [i32 LE]         m_volume            — volume taken by this object
 *
 *   TangibleObject::addSharedVariable order (9 fields):
 *     [u32 LE]         m_pvpFaction        — pvp faction (CrcLowerString of faction name)
 *     [i32 LE]         m_pvpType           — pvp type (PvpType enum)
 *     [std::string]    m_appearanceData    — appearance override string (often empty)
 *     [AutoDeltaSet<int>] m_components     — component table ids of visible attached components
 *     [i32 LE]         m_condition         — bit flags (Conditions::* enum)
 *     [i32 LE]         m_count             — generic counter (stack size for stackables)
 *     [i32 LE]         m_damageTaken       — accumulated damage
 *     [i32 LE]         m_maxHitPoints      — max HP (callback-wrapped)
 *     [u8]             m_visible           — bool: object visible to non-owner observers
 *
 * Total: 13 members (4 from ServerObject + 9 from TangibleObject).
 *
 * Source (member adds):
 *   /home/tharper/code/swg-main/src/engine/server/library/serverGame/src/shared/generated/Packager.cpp
 *   lines 557-591 (ServerObject) and 689-724 (TangibleObject)
 *
 * Source (member types):
 *   /home/tharper/code/swg-main/src/engine/server/library/serverGame/src/shared/object/ServerObject.h:752-773
 *   /home/tharper/code/swg-main/src/engine/server/library/serverGame/src/shared/object/TangibleObject.h:547-571
 */

import type { IReadIterator } from '../../../archive/interface.js';
import { readStdString } from '../../../archive/string.js';
import { readUnicodeString } from '../../../archive/unicode-string.js';
import { readAndCheckMemberCount } from './auto-byte-stream.js';
import { readAutoDeltaSetI32 } from './auto-delta-codecs.js';
import { BaselinePackageIds, ObjectTypeTags, registerBaseline } from './registry.js';
import { StringIdCodec, type StringIdValue } from './string-id.js';

export interface TangibleObjectSharedBaseline {
  // From ServerObject
  complexity: number;
  nameStringId: StringIdValue;
  objectName: string;
  volume: number;
  // From TangibleObject
  pvpFaction: number;
  pvpType: number;
  appearanceData: string;
  /** Set of component table ids; from `AutoDeltaSet<int>` (sorted set semantics). */
  components: number[];
  /**
   * Bit flags (Conditions::* enum — C_onOff, C_vendor, C_insured, C_conversable,
   * C_hibernating, C_magicItem, C_crafted, C_factoryItem, C_outOfRange,
   * C_docking, C_disabled, C_uninsurable, C_wingsOpen).
   */
  condition: number;
  /** Stack count for stackable items; otherwise object-specific counter. */
  count: number;
  damageTaken: number;
  maxHitPoints: number;
  /** True if visible to non-owner observers. */
  visible: boolean;
}

export const TangibleObjectSharedKind = 'TangibleObjectShared' as const;

/** Member count must match the sum of ServerObject's + TangibleObject's shared variables. */
const EXPECTED_MEMBER_COUNT = 13;

export const TangibleObjectSharedDecoder = registerBaseline<TangibleObjectSharedBaseline>({
  kind: TangibleObjectSharedKind,
  typeId: ObjectTypeTags.TANO,
  packageId: BaselinePackageIds.SHARED,
  expectedMemberCount: EXPECTED_MEMBER_COUNT,
  decode(iter: IReadIterator): TangibleObjectSharedBaseline {
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
