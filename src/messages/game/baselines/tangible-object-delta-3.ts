/**
 * TangibleObject DELTAS_SHARED (packageId 3) — server-to-client.
 *
 * Delta counterpart to `TangibleObjectSharedDecoder` (the baseline decoder
 * for the same `(typeId, packageId)` pair). This is the **most-broadcast
 * delta package** in the wire protocol — every player, NPC, vehicle, and
 * item the client observes carries one, and any change to that object's
 * publicly-visible state arrives here: a custom name being applied, a
 * component being attached, condition bit flags flipping (insured, vendor,
 * crafted, ...), stack counts ticking, damage accumulating, max-HP buffs,
 * visibility toggling.
 *
 * Field order (matches `TangibleObjectSharedBaseline.decode()` read order
 * exactly — see `tangible-object-baseline-3.ts`):
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
 * Total: 13 fields, matching `TangibleObjectSharedDecoder.expectedMemberCount`.
 *
 * Source for field order:
 *   /home/tharper/code/swg-main/src/engine/server/library/serverGame/src/shared/generated/Packager.cpp
 *   lines 557-591 (ServerObject) and 689-724 (TangibleObject)
 *
 * # AutoDelta* container fields
 *
 *   index 7 (components) — AutoDeltaSet<i32>; delta wire format is a sequence
 *   of ERASE/INSERT/CLEAR commands (see `readAutoDeltaSetDelta`).
 */

import { readStdString } from '../../../archive/string.js';
import { readUnicodeString } from '../../../archive/unicode-string.js';
import { readAutoDeltaSetDelta } from './auto-delta-delta-codecs.js';
import { type DeltaPackageDecoder, registerDelta } from './delta-registry.js';
import { BaselinePackageIds, ObjectTypeTags } from './registry.js';
import { StringIdCodec } from './string-id.js';
import type { TangibleObjectSharedBaseline } from './tangible-object-baseline-3.js';

export const TangibleObjectSharedDeltaKind = 'TangibleObjectSharedDelta' as const;

export const TangibleObjectSharedDeltaDecoder: DeltaPackageDecoder<TangibleObjectSharedBaseline> =
  registerDelta<TangibleObjectSharedBaseline>({
    kind: TangibleObjectSharedDeltaKind,
    typeId: ObjectTypeTags.TANO,
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
    ],
  });
