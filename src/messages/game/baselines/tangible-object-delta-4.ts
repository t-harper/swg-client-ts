/**
 * TangibleObject DELTAS_CLIENT_SERVER_NP (packageId 4) — server-to-client.
 *
 * Delta counterpart to `TangibleObjectClientServerNpDecoder` (the baseline
 * decoder for the same `(typeId, packageId)` pair). The "CLIENT_SERVER_NP"
 * package is the AUTH-client-only, NOT-persisted transient state.
 *
 * Field order (matches `TangibleObjectClientServerNpBaseline.decode()` —
 * which has **no fields**):
 *   (none)
 *
 * Both ServerObject and TangibleObject contribute zero
 * `addAuthClientServerVariable_np` calls, so the package has no members
 * and no delta entries can ever target a valid field index. The decoder
 * is still registered for symmetry with the baseline decoder and so the
 * `(typeId, packageId)` pair is recognized at dispatch (returning a
 * decoded delta with empty `data` instead of `null`).
 *
 * Source for the field order:
 *   /home/tharper/code/swg-main/src/engine/server/library/serverGame/src/shared/generated/Packager.cpp
 *   lines 557-591 (ServerObject — no `addAuthClientServerVariable_np` calls)
 *   lines 691-724 (TangibleObject — no `addAuthClientServerVariable_np` calls)
 */

import { type DeltaPackageDecoder, registerDelta } from './delta-registry.js';
import { BaselinePackageIds, ObjectTypeTags } from './registry.js';
import type { TangibleObjectClientServerNpBaseline } from './tangible-object-baseline-4.js';

export const TangibleObjectClientServerNpDeltaKind = 'TangibleObjectClientServerNpDelta' as const;

export const TangibleObjectClientServerNpDeltaDecoder: DeltaPackageDecoder<TangibleObjectClientServerNpBaseline> =
  registerDelta<TangibleObjectClientServerNpBaseline>({
    kind: TangibleObjectClientServerNpDeltaKind,
    typeId: ObjectTypeTags.TANO,
    packageId: BaselinePackageIds.CLIENT_SERVER_NP,
    fields: [],
  });
