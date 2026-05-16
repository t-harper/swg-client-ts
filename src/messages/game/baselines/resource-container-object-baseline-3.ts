/**
 * ResourceContainerObject baseline package 3 (BASELINES_SHARED) — server-to-client.
 *
 * The "SHARED" baseline is sent to ALL clients observing the object. For
 * resource crates, this carries the publicly-visible state — name, condition,
 * pvp metadata, etc. inherited from TangibleObject and ServerObject — plus
 * two ResourceContainerObject-specific shared fields:
 *   - quantity      (current resource units)
 *   - resourceType  (NetworkId of the ResourceTypeObject; can be looked up
 *                    via the parallel resource-tree to resolve to a class
 *                    name like "iron_class_3" and a spawned name like
 *                    "Heshurium").
 *
 * `ResourceContainerObject extends TangibleObject extends ServerObject`. The
 * `addMembersToPackages` (Packager.cpp:543-552) lists for the SHARED package:
 *
 *   addSharedVariable    (m_quantity);
 *   addSharedVariable    (m_resourceType);
 *
 * The remaining ResourceContainerObject fields (`m_source`, `m_maxQuantity`,
 * `m_parentName`, `m_resourceName`, `m_resourceNameId`) live on other
 * packages (server-only or SHARED_NP), so they do NOT appear here.
 *
 * Member order (inherited TANO SHARED + 2 RCNO-specific):
 *
 *   ServerObject::addSharedVariable order (4 fields):
 *     [f32 LE]         m_complexity
 *     [StringId]       m_nameStringId
 *     [Unicode::String] m_objectName
 *     [i32 LE]         m_volume
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
 *   ResourceContainerObject::addSharedVariable order (2 fields):
 *     [i32 LE]         m_quantity
 *     [NetworkId i64]  m_resourceType
 *
 * Total: 15 members (4 + 9 + 2).
 *
 * Source (member adds):
 *   /home/tharper/code/swg-main/src/engine/server/library/serverGame/src/shared/generated/Packager.cpp
 *   lines 557-591 (ServerObject), 689-724 (TangibleObject), 543-552 (ResourceContainerObject)
 *
 * Source (ResourceContainerObject class):
 *   /home/tharper/code/swg-main/src/engine/server/library/serverGame/src/shared/object/ResourceContainerObject.{h,cpp}
 *
 * Source (template tag):
 *   /home/tharper/code/swg-main/src/engine/server/library/serverGame/src/shared/objectTemplate/ServerResourceContainerObjectTemplate.h:33
 *   → `ServerResourceContainerObjectTemplate_tag = TAG(R,C,N,O)`.
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

export interface ResourceContainerObjectSharedBaseline {
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
  // From ResourceContainerObject
  /** Current units of resource in this crate. */
  quantity: number;
  /** NetworkId of the ResourceTypeObject this crate carries. */
  resourceType: NetworkId;
}

export const ResourceContainerObjectSharedKind = 'ResourceContainerObjectShared' as const;

/** 4 (ServerObject) + 9 (TangibleObject) + 2 (ResourceContainerObject) = 15. */
const EXPECTED_MEMBER_COUNT = 15;

export const ResourceContainerObjectSharedDecoder =
  registerBaseline<ResourceContainerObjectSharedBaseline>({
    kind: ResourceContainerObjectSharedKind,
    typeId: ObjectTypeTags.RCNO,
    packageId: BaselinePackageIds.SHARED,
    expectedMemberCount: EXPECTED_MEMBER_COUNT,
    decode(iter: IReadIterator): ResourceContainerObjectSharedBaseline {
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
      // ResourceContainerObject section
      const quantity = iter.readI32();
      const resourceType = NetworkIdCodec.decode(iter);
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
        quantity,
        resourceType,
      };
    },
  });
