/**
 * CreatureObject DELTAS_FIRST_PARENT_CLIENT_SERVER (packageId 8) —
 * server-to-client.
 *
 * Delta counterpart to `CreatureObjectFirstParentClientServerDecoder` (the
 * baseline decoder for the same `(typeId, packageId)` pair). The
 * "FIRST_PARENT_CLIENT_SERVER" package is delivered to the auth client of
 * the object's FIRST_PARENT (root container — e.g. for a PlayerObject
 * contained inside a CreatureObject, the first-parent auth client is the
 * player who owns the creature).
 *
 * Field order (matches `CreatureObjectFirstParentClientServerBaseline.decode()`):
 *   (none)
 *
 * Looking at `Packager.cpp`:
 *   - ServerObject contributes 0 fields via `addFirstParentAuthClientServerVariable`.
 *   - TangibleObject contributes 0 fields.
 *   - CreatureObject contributes 0 fields.
 *   (PlayerObject DOES contribute 9 fields here — those land in PLAY p8.)
 *
 * So CREO p8 has NO fields. Any well-formed delta payload is therefore
 * exactly `[u16 0]` (zero changed fields) and decodes to an empty `data`
 * object. Any non-empty payload (count > 0 OR trailing bytes after the
 * count) references a field index that doesn't exist and gets swallowed
 * by `tryDecodeDelta` as `null`.
 *
 * Registering this decoder is still useful: it lets the higher-level
 * dispatcher distinguish "we know about this (typeId, packageId) and it's
 * empty" from "we don't have a decoder for this pair" — the former emits
 * a `DecodedDelta` with an empty `data`, the latter emits `null`.
 *
 * Source for the field order:
 *   /home/tharper/code/swg-main/src/engine/server/library/serverGame/src/shared/generated/Packager.cpp
 *   lines 110-199 (CreatureObject — no `addFirstParentAuthClientServerVariable` calls)
 */

import type { CreatureObjectFirstParentClientServerBaseline } from './creature-object-baseline-8.js';
import { type DeltaPackageDecoder, registerDelta } from './delta-registry.js';
import { BaselinePackageIds, ObjectTypeTags } from './registry.js';

export const CreatureObjectFirstParentClientServerDeltaKind =
  'CreatureObjectFirstParentClientServerDelta' as const;

export const CreatureObjectFirstParentClientServerDeltaDecoder: DeltaPackageDecoder<CreatureObjectFirstParentClientServerBaseline> =
  registerDelta<CreatureObjectFirstParentClientServerBaseline>({
    kind: CreatureObjectFirstParentClientServerDeltaKind,
    typeId: ObjectTypeTags.CREO,
    packageId: BaselinePackageIds.FIRST_PARENT_CLIENT_SERVER,
    fields: [],
  });
