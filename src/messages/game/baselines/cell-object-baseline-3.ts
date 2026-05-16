/**
 * CellObject baseline package 3 (BASELINES_SHARED) — server-to-client.
 *
 * Cells are the rooms inside a building. Each `BuildingObject` has N child
 * `CellObject` instances (`mos_eisley/cantina/cantina_room_1`, etc.). The
 * cell NetworkId is what `UpdateTransformWithParentMessage` references as
 * the parent — knowing a cell's NetworkId is a prerequisite for
 * cell-relative movement.
 *
 * `CellObject extends ServerObject` (NOT TangibleObject), so its SHARED
 * baseline only inherits ServerObject's 4 shared variables and adds its
 * own 2 (cellNumber, isPublic). The cell's label and label-location-offset
 * live in SHARED_NP (package 6), not SHARED.
 *
 * Member order (matches `Packager.cpp::ServerObject::addMembersToPackages`
 * + `CellObject::addMembersToPackages`):
 *
 *   ServerObject::addSharedVariable order (4 fields):
 *     [f32 LE]         m_complexity
 *     [StringId]       m_nameStringId
 *     [Unicode::String] m_objectName
 *     [i32 LE]         m_volume
 *
 *   CellObject::addSharedVariable order (2 fields):
 *     [u8]             m_isPublic        — bool: anyone can enter
 *     [i32 LE]         m_cellNumber      — index into the building's cell table
 *
 * Total: 6 members.
 *
 * Source (member adds):
 *   /home/tharper/code/swg-main/src/engine/server/library/serverGame/src/shared/generated/Packager.cpp
 *   lines 557-591 (ServerObject) and 78-86 (CellObject)
 *
 * Source (CellObject class):
 *   /home/tharper/code/swg-main/src/engine/server/library/serverGame/src/shared/object/CellObject.{h,cpp}
 */

import type { IReadIterator } from '../../../archive/interface.js';
import { readUnicodeString } from '../../../archive/unicode-string.js';
import { readAndCheckMemberCount } from './auto-byte-stream.js';
import { BaselinePackageIds, ObjectTypeTags, registerBaseline } from './registry.js';
import { StringIdCodec, type StringIdValue } from './string-id.js';

export interface CellObjectSharedBaseline {
  // From ServerObject
  complexity: number;
  nameStringId: StringIdValue;
  objectName: string;
  volume: number;
  // From CellObject
  /** True if any player can enter the cell (false = ACL-gated). */
  isPublic: boolean;
  /** Index into the building's cell table (1-based; -1 if unset). */
  cellNumber: number;
}

export const CellObjectSharedKind = 'CellObjectShared' as const;

const EXPECTED_MEMBER_COUNT = 6;

export const CellObjectSharedDecoder = registerBaseline<CellObjectSharedBaseline>({
  kind: CellObjectSharedKind,
  typeId: ObjectTypeTags.SCLT,
  packageId: BaselinePackageIds.SHARED,
  expectedMemberCount: EXPECTED_MEMBER_COUNT,
  decode(iter: IReadIterator): CellObjectSharedBaseline {
    readAndCheckMemberCount(iter, EXPECTED_MEMBER_COUNT);
    // ServerObject section
    const complexity = iter.readF32();
    const nameStringId = StringIdCodec.decode(iter);
    const objectName = readUnicodeString(iter);
    const volume = iter.readI32();
    // CellObject section
    const isPublic = iter.readBool();
    const cellNumber = iter.readI32();
    return {
      complexity,
      nameStringId,
      objectName,
      volume,
      isPublic,
      cellNumber,
    };
  },
});
