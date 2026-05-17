/**
 * CellObject baseline package 6 (BASELINES_SHARED_NP) — server-to-client.
 *
 * Cells are the rooms inside a building. Their persisted SHARED state is the
 * `cellNumber` + `isPublic` flag (baseline 3). Their *transient* shared state
 * is the room's *label* (a free-text Unicode string visible to clients, used
 * for things like player house room labels: "Travis's Library") and the
 * offset within the cell at which that label should be drawn.
 *
 * `CellObject extends ServerObject` (NOT TangibleObject), so its SHARED_NP
 * baseline only inherits ServerObject's 2 shared_np variables and adds its
 * own 2 (cellLabel, labelLocationOffset).
 *
 * Member order (matches `Packager.cpp::ServerObject::addMembersToPackages`
 * + `CellObject::addMembersToPackages`):
 *
 *   ServerObject::addSharedVariable_np order (2 fields):
 *     [u32]                m_authServerProcessId
 *     [StringId]           m_descriptionStringId
 *
 *   CellObject::addSharedVariable_np order (2 fields):
 *     [Unicode::String]    m_cellLabel             — player-set room label
 *     [Vector]             m_labelLocationOffset   — where to draw the label, cell-relative
 *
 * Total: 4 members.
 *
 * Source (member adds):
 *   /home/tharper/code/swg-main/src/engine/server/library/serverGame/src/shared/generated/Packager.cpp
 *   lines 557-591 (ServerObject) and 78-86 (CellObject)
 *
 * Source (CellObject class):
 *   /home/tharper/code/swg-main/src/engine/server/library/serverGame/src/shared/object/CellObject.{h,cpp}
 */

import type { IReadIterator } from '../../../archive/interface.js';
import { Vector3Codec } from '../../../archive/transform.js';
import { readUnicodeString } from '../../../archive/unicode-string.js';
import type { Vector3 } from '../../../types.js';
import { readAndCheckMemberCount } from './auto-byte-stream.js';
import { BaselinePackageIds, ObjectTypeTags, registerBaseline } from './registry.js';
import { StringIdCodec, type StringIdValue } from './string-id.js';

export interface CellObjectSharedNpBaseline {
  // From ServerObject
  authServerProcessId: number;
  descriptionStringId: StringIdValue;
  // From CellObject
  /** Player-assigned room label (e.g. "Travis's Library"); empty string if unset. */
  cellLabel: string;
  /** Cell-relative offset at which to draw `cellLabel`. */
  labelLocationOffset: Vector3;
}

export const CellObjectSharedNpKind = 'CellObjectSharedNp' as const;

const EXPECTED_MEMBER_COUNT = 4;

export const CellObjectSharedNpDecoder = registerBaseline<CellObjectSharedNpBaseline>({
  kind: CellObjectSharedNpKind,
  typeId: ObjectTypeTags.SCLT,
  packageId: BaselinePackageIds.SHARED_NP,
  expectedMemberCount: EXPECTED_MEMBER_COUNT,
  decode(iter: IReadIterator): CellObjectSharedNpBaseline {
    readAndCheckMemberCount(iter, EXPECTED_MEMBER_COUNT);
    // ServerObject section
    const authServerProcessId = iter.readU32();
    const descriptionStringId = StringIdCodec.decode(iter);
    // CellObject section
    const cellLabel = readUnicodeString(iter);
    const labelLocationOffset = Vector3Codec.decode(iter);
    return {
      authServerProcessId,
      descriptionStringId,
      cellLabel,
      labelLocationOffset,
    };
  },
});
