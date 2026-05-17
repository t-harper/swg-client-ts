/**
 * CreatureObject DELTAS_SHARED (packageId 3) — server-to-client.
 *
 * Delta counterpart to `CreatureObjectSharedDecoder` (the baseline decoder for
 * the same `(typeId, packageId)` pair). Carries incremental updates to the
 * publicly-visible CreatureObject fields every nearby client observes —
 * posture changes (sit/stand/crouch/dead), combat state toggles, master id
 * shifts on pet ownership change, scale factor changes (size buffs/debuffs),
 * shock-wound accumulation, etc.
 *
 * Field order (matches `CreatureObjectSharedBaseline.decode()` read order
 * exactly — see `creature-object-baseline-3.ts`):
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
 *   CreatureObject section (6 fields):
 *     index 13 — posture         (i8)
 *     index 14 — rank            (u8)
 *     index 15 — masterId        (NetworkId i64)
 *     index 16 — scaleFactor     (f32)
 *     index 17 — shockWounds     (i32)
 *     index 18 — states          (u64)
 *
 * Total: 19 fields, matching `CreatureObjectSharedDecoder.expectedMemberCount`.
 *
 * Source for field order:
 *   /home/tharper/code/swg-main/src/engine/server/library/serverGame/src/shared/generated/Packager.cpp
 *   lines 570-573 (ServerObject), 691-707 (TangibleObject), 110-124 (CreatureObject)
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
import type { CreatureObjectSharedBaseline } from './creature-object-baseline-3.js';
import { type DeltaPackageDecoder, registerDelta } from './delta-registry.js';
import { BaselinePackageIds, ObjectTypeTags } from './registry.js';
import { StringIdCodec } from './string-id.js';

export const CreatureObjectSharedDeltaKind = 'CreatureObjectSharedDelta' as const;

export const CreatureObjectSharedDeltaDecoder: DeltaPackageDecoder<CreatureObjectSharedBaseline> =
  registerDelta<CreatureObjectSharedBaseline>({
    kind: CreatureObjectSharedDeltaKind,
    typeId: ObjectTypeTags.CREO,
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
      // CreatureObject section
      { name: 'posture', decode: (iter) => iter.readI8() },
      { name: 'rank', decode: (iter) => iter.readU8() },
      { name: 'masterId', decode: NetworkIdCodec.decode },
      { name: 'scaleFactor', decode: (iter) => iter.readF32() },
      { name: 'shockWounds', decode: (iter) => iter.readI32() },
      { name: 'states', decode: (iter) => iter.readU64() },
    ],
  });
