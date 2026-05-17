/**
 * CellObject DELTAS_SHARED (packageId 3) — server-to-client.
 *
 * Delta counterpart to `CellObjectSharedDecoder` (the baseline decoder for the
 * same `(typeId, packageId)` pair). Carries incremental updates to the
 * publicly-visible CellObject fields any nearby client observes: rename a
 * room, flip its public/private flag, etc.
 *
 * `CellObject extends ServerObject` (NOT TangibleObject), so this package
 * only inherits ServerObject's 4 shared variables plus CellObject's own 2
 * (`isPublic`, `cellNumber`). The cell's label and label-location-offset
 * live in SHARED_NP (package 6), not here.
 *
 * Field order (matches `CellObjectSharedBaseline.decode()` read order
 * exactly — see `cell-object-baseline-3.ts`):
 *
 *   ServerObject section (4 fields):
 *     index 0 — complexity     (f32)
 *     index 1 — nameStringId   (StringId)
 *     index 2 — objectName     (Unicode::String)
 *     index 3 — volume         (i32)
 *
 *   CellObject section (2 fields):
 *     index 4 — isPublic       (u8 bool)
 *     index 5 — cellNumber     (i32)
 *
 * Total: 6 fields, matching `CellObjectSharedDecoder.expectedMemberCount`.
 *
 * Source for field order:
 *   /home/tharper/code/swg-main/src/engine/server/library/serverGame/src/shared/generated/Packager.cpp
 *   lines 557-591 (ServerObject) and 78-86 (CellObject)
 *
 * # AutoDelta* container fields
 *
 *   None — every field in this package is a primitive (or the StringId /
 *   Unicode::String tuple), so delta payloads always carry a single fresh
 *   value per touched field index.
 */

import { readUnicodeString } from '../../../archive/unicode-string.js';
import type { CellObjectSharedBaseline } from './cell-object-baseline-3.js';
import { type DeltaPackageDecoder, registerDelta } from './delta-registry.js';
import { BaselinePackageIds, ObjectTypeTags } from './registry.js';
import { StringIdCodec } from './string-id.js';

export const CellObjectSharedDeltaKind = 'CellObjectSharedDelta' as const;

export const CellObjectSharedDeltaDecoder: DeltaPackageDecoder<CellObjectSharedBaseline> =
  registerDelta<CellObjectSharedBaseline>({
    kind: CellObjectSharedDeltaKind,
    typeId: ObjectTypeTags.SCLT,
    packageId: BaselinePackageIds.SHARED,
    fields: [
      // ServerObject section
      { name: 'complexity', decode: (iter) => iter.readF32() },
      { name: 'nameStringId', decode: StringIdCodec.decode },
      { name: 'objectName', decode: readUnicodeString },
      { name: 'volume', decode: (iter) => iter.readI32() },
      // CellObject section
      { name: 'isPublic', decode: (iter) => iter.readBool() },
      { name: 'cellNumber', decode: (iter) => iter.readI32() },
    ],
  });
