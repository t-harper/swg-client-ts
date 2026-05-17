/**
 * BuildingObject DELTAS_SHARED (packageId 3) — server-to-client.
 *
 * Delta counterpart to `BuildingObjectSharedDecoder` (the baseline decoder for
 * the same `(typeId, packageId)` pair). Carries incremental updates to the
 * publicly-visible BuildingObject fields every nearby client observes —
 * name changes, condition/damage updates as the structure takes wear or is
 * repaired, hit-point cap shifts on upgrade, visibility toggles, etc.
 *
 * `BuildingObject extends TangibleObject extends ServerObject` and adds ZERO
 * SHARED variables on top of TangibleObject. So the field layout is identical
 * to `TangibleObjectSharedBaseline` — but the wire `typeId` is `BUIO`, so it
 * needs its own delta decoder registration to be queryable.
 *
 * Field order (matches `BuildingObjectSharedBaseline.decode()` read order
 * exactly — see `building-object-baseline-3.ts`):
 *
 *   ServerObject section (4 fields):
 *     index  0 — complexity      (f32)
 *     index  1 — nameStringId    (StringId)
 *     index  2 — objectName      (Unicode::String)
 *     index  3 — volume          (i32)
 *
 *   TangibleObject section (9 fields):
 *     index  4 — pvpFaction      (u32)
 *     index  5 — pvpType         (i32)
 *     index  6 — appearanceData  (std::string)
 *     index  7 — components      (AutoDeltaSet<i32>)
 *     index  8 — condition       (i32)
 *     index  9 — count           (i32)
 *     index 10 — damageTaken     (i32)
 *     index 11 — maxHitPoints    (i32)
 *     index 12 — visible         (u8 bool)
 *
 *   BuildingObject section (0 fields — adds nothing to SHARED).
 *
 * Total: 13 fields, matching `BuildingObjectSharedDecoder.expectedMemberCount`.
 *
 * Source for field order:
 *   /home/tharper/code/swg-main/src/engine/server/library/serverGame/src/shared/generated/Packager.cpp
 *   lines 557-591 (ServerObject), 691-724 (TangibleObject), 64-73 (BuildingObject — no SHARED adds)
 *
 * # AutoDelta* container fields
 *
 *   index 7 (components) — AutoDeltaSet<i32>; delta wire format is a sequence
 *   of ERASE/INSERT/CLEAR commands (see `readAutoDeltaSetDelta`).
 */

import { readStdString } from '../../../archive/string.js';
import { readUnicodeString } from '../../../archive/unicode-string.js';
import { readAutoDeltaSetDelta } from './auto-delta-delta-codecs.js';
import type { BuildingObjectSharedBaseline } from './building-object-baseline-3.js';
import { type DeltaPackageDecoder, registerDelta } from './delta-registry.js';
import { BaselinePackageIds, ObjectTypeTags } from './registry.js';
import { StringIdCodec } from './string-id.js';

export const BuildingObjectSharedDeltaKind = 'BuildingObjectSharedDelta' as const;

export const BuildingObjectSharedDeltaDecoder: DeltaPackageDecoder<BuildingObjectSharedBaseline> =
  registerDelta<BuildingObjectSharedBaseline>({
    kind: BuildingObjectSharedDeltaKind,
    typeId: ObjectTypeTags.BUIO,
    packageId: BaselinePackageIds.SHARED,
    fields: [
      // ServerObject section
      { name: 'complexity', decode: (iter) => iter.readF32() },
      { name: 'nameStringId', decode: StringIdCodec.decode },
      { name: 'objectName', decode: readUnicodeString },
      { name: 'volume', decode: (iter) => iter.readI32() },
      // TangibleObject section
      { name: 'pvpFaction', decode: (iter) => iter.readU32() },
      { name: 'pvpType', decode: (iter) => iter.readI32() },
      { name: 'appearanceData', decode: readStdString },
      { name: 'components', decode: (iter) => readAutoDeltaSetDelta(iter, (i) => i.readI32()) },
      { name: 'condition', decode: (iter) => iter.readI32() },
      { name: 'count', decode: (iter) => iter.readI32() },
      { name: 'damageTaken', decode: (iter) => iter.readI32() },
      { name: 'maxHitPoints', decode: (iter) => iter.readI32() },
      { name: 'visible', decode: (iter) => iter.readBool() },
      // BuildingObject section — adds zero SHARED variables.
    ],
  });
