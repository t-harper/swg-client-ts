/**
 * ResourceContainerObject DELTAS_SHARED (packageId 3) — server-to-client.
 *
 * Delta counterpart to `ResourceContainerObjectSharedDecoder` (the baseline
 * decoder for the same `(typeId, packageId)` pair). Carries incremental
 * updates to the publicly-visible fields of a resource crate that every
 * nearby client observes — most commonly `quantity` (units changing as a
 * harvester deposits or a player splits/stacks the crate), `resourceType`
 * (rare — usually only at crate creation), and any inherited TangibleObject /
 * ServerObject field (object name renames, condition damage, visibility
 * toggles, etc.).
 *
 * Field order (matches `ResourceContainerObjectSharedBaseline.decode()` read
 * order exactly — see `resource-container-object-baseline-3.ts`):
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
 *   ResourceContainerObject section (2 fields):
 *     index 13 — quantity        (i32)
 *     index 14 — resourceType    (NetworkId i64)
 *
 * Total: 15 fields, matching `ResourceContainerObjectSharedDecoder.expectedMemberCount`.
 *
 * Source for field order:
 *   /home/tharper/code/swg-main/src/engine/server/library/serverGame/src/shared/generated/Packager.cpp
 *   lines 557-591 (ServerObject), 689-724 (TangibleObject), 543-552 (ResourceContainerObject)
 *
 * # AutoDelta* container fields
 *
 *   index 7 (components) — AutoDeltaSet<i32>; delta wire format is a sequence
 *   of ERASE/INSERT/CLEAR commands (see `readAutoDeltaSetDelta`).
 */

import { NetworkIdCodec } from '../../../archive/network-id.js';
import { readStdString } from '../../../archive/string.js';
import { readUnicodeString } from '../../../archive/unicode-string.js';
import { readAutoDeltaSetDelta } from './auto-delta-delta-codecs.js';
import { type DeltaPackageDecoder, registerDelta } from './delta-registry.js';
import { BaselinePackageIds, ObjectTypeTags } from './registry.js';
import type { ResourceContainerObjectSharedBaseline } from './resource-container-object-baseline-3.js';
import { StringIdCodec } from './string-id.js';

export const ResourceContainerObjectSharedDeltaKind = 'ResourceContainerObjectSharedDelta' as const;

export const ResourceContainerObjectSharedDeltaDecoder: DeltaPackageDecoder<ResourceContainerObjectSharedBaseline> =
  registerDelta<ResourceContainerObjectSharedBaseline>({
    kind: ResourceContainerObjectSharedDeltaKind,
    typeId: ObjectTypeTags.RCNO,
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
      // ResourceContainerObject section
      { name: 'quantity', decode: (iter) => iter.readI32() },
      { name: 'resourceType', decode: NetworkIdCodec.decode },
    ],
  });
