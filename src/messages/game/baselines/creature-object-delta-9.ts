/**
 * CreatureObject DELTAS_FIRST_PARENT_CLIENT_SERVER_NP (packageId 9) —
 * server-to-client.
 *
 * Delta counterpart to `CreatureObjectFirstParentClientServerNpDecoder`
 * (the baseline decoder for the same `(typeId, packageId)` pair).
 *
 * Looking at `Packager.cpp`:
 *   - ServerObject contributes 0 fields via `addFirstParentAuthClientServerVariable_np`.
 *   - TangibleObject contributes 0 fields.
 *   - CreatureObject contributes 0 fields.
 *   (PlayerObject contributes 29 fields in PLAY p9, but that's a different
 *    `(typeId, packageId)` pair — CREO p9 is empty.)
 *
 * So CREO p9 has NO fields. The delta decoder is registered with an empty
 * `fields` array; this matches the baseline's `expectedMemberCount = 0`.
 *
 * Wire shape for an empty delta:
 *   [u16 count = 0]   ← no field entries follow
 *
 * Any incoming delta with `count > 0` will fail (the first u16 fieldIndex
 * read will throw "out of range" via `delta-registry`, and `tryDecodeDelta`
 * returns null). This is the correct behavior — a delta carrying a payload
 * for a zero-field package is wire drift, not a structural mismatch we
 * should silently absorb.
 *
 * Field order: (none)
 *
 * Source for the field order:
 *   /home/tharper/code/swg-main/src/engine/server/library/serverGame/src/shared/generated/Packager.cpp
 *   lines 110-199 (CreatureObject — no `addFirstParentAuthClientServerVariable_np` calls)
 */

import type { CreatureObjectFirstParentClientServerNpBaseline } from './creature-object-baseline-9.js';
import { type DeltaPackageDecoder, registerDelta } from './delta-registry.js';
import { BaselinePackageIds, ObjectTypeTags } from './registry.js';

export const CreatureObjectFirstParentClientServerNpDeltaKind =
  'CreatureObjectFirstParentClientServerNpDelta' as const;

export const CreatureObjectFirstParentClientServerNpDeltaDecoder: DeltaPackageDecoder<CreatureObjectFirstParentClientServerNpBaseline> =
  registerDelta<CreatureObjectFirstParentClientServerNpBaseline>({
    kind: CreatureObjectFirstParentClientServerNpDeltaKind,
    typeId: ObjectTypeTags.CREO,
    packageId: BaselinePackageIds.FIRST_PARENT_CLIENT_SERVER_NP,
    fields: [],
  });
