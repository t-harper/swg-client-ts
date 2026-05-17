/**
 * CellObject DELTAS_SHARED_NP (packageId 6) — server-to-client.
 *
 * Delta counterpart to `CellObjectSharedNpDecoder` (the baseline decoder
 * for the same `(typeId, packageId)` pair). Carries incremental updates
 * to the *transient* shared state of a cell — the player-set room label
 * and the cell-relative offset at which that label should be drawn —
 * plus the two ServerObject SHARED_NP fields (auth-server process id and
 * description string id) that every server object inherits.
 *
 * Field order (matches `CellObjectSharedNpBaseline.decode()` read order
 * exactly — see `cell-object-baseline-6.ts`):
 *
 *   ServerObject section (2 fields):
 *     index 0 — authServerProcessId   (u32)
 *     index 1 — descriptionStringId   (StringId)
 *
 *   CellObject section (2 fields):
 *     index 2 — cellLabel             (Unicode::String)
 *     index 3 — labelLocationOffset   (Vector — 3×f32)
 *
 * Total: 4 fields, matching `CellObjectSharedNpDecoder.expectedMemberCount`.
 *
 * None of the 4 fields are AutoDelta* containers — each is a primitive or
 * fixed-shape custom codec, so all entries use baseline-equivalent reads.
 *
 * Source for the field order:
 *   /home/tharper/code/swg-main/src/engine/server/library/serverGame/src/shared/generated/Packager.cpp
 *   lines 557-591 (ServerObject SHARED_NP) and 78-86 (CellObject SHARED_NP)
 */

import { Vector3Codec } from '../../../archive/transform.js';
import { readUnicodeString } from '../../../archive/unicode-string.js';
import type { CellObjectSharedNpBaseline } from './cell-object-baseline-6.js';
import { type DeltaPackageDecoder, registerDelta } from './delta-registry.js';
import { BaselinePackageIds, ObjectTypeTags } from './registry.js';
import { StringIdCodec } from './string-id.js';

export const CellObjectSharedNpDeltaKind = 'CellObjectSharedNpDelta' as const;

export const CellObjectSharedNpDeltaDecoder: DeltaPackageDecoder<CellObjectSharedNpBaseline> =
  registerDelta<CellObjectSharedNpBaseline>({
    kind: CellObjectSharedNpDeltaKind,
    typeId: ObjectTypeTags.SCLT,
    packageId: BaselinePackageIds.SHARED_NP,
    fields: [
      // ServerObject section
      { name: 'authServerProcessId', decode: (iter) => iter.readU32() },
      { name: 'descriptionStringId', decode: (iter) => StringIdCodec.decode(iter) },
      // CellObject section
      { name: 'cellLabel', decode: (iter) => readUnicodeString(iter) },
      { name: 'labelLocationOffset', decode: (iter) => Vector3Codec.decode(iter) },
    ],
  });
