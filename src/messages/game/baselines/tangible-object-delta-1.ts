/**
 * TangibleObject DELTAS_CLIENT_SERVER (packageId 1) — server-to-client.
 *
 * Delta counterpart to `TangibleObjectClientServerDecoder` (the baseline
 * decoder for the same `(typeId, packageId)` pair). Carries incremental
 * updates to the owner-only fields `bankBalance` and `cashBalance` for any
 * `TangibleObject` (which on CreatureObject players means real bank/cash
 * credit changes — every credit gain, loss, transfer, payout fires one).
 *
 * Field order (matches `TangibleObjectClientServerBaseline`):
 *   index 0 — bankBalance (i32)
 *   index 1 — cashBalance (i32)
 *
 * Source for the field order:
 *   /home/tharper/code/swg-main/src/engine/server/library/serverGame/src/shared/generated/Packager.cpp:574-575
 *   (`ServerObject::addAuthClientServerVariable` adds bank then cash; no
 *   TangibleObject-level fields contribute to this package.)
 */

import { type DeltaPackageDecoder, registerDelta } from './delta-registry.js';
import { BaselinePackageIds, ObjectTypeTags } from './registry.js';
import type { TangibleObjectClientServerBaseline } from './tangible-object-baseline-1.js';

export const TangibleObjectClientServerDeltaKind = 'TangibleObjectClientServerDelta' as const;

export const TangibleObjectClientServerDeltaDecoder: DeltaPackageDecoder<TangibleObjectClientServerBaseline> =
  registerDelta<TangibleObjectClientServerBaseline>({
    kind: TangibleObjectClientServerDeltaKind,
    typeId: ObjectTypeTags.TANO,
    packageId: BaselinePackageIds.CLIENT_SERVER,
    fields: [
      { name: 'bankBalance', decode: (iter) => iter.readI32() },
      { name: 'cashBalance', decode: (iter) => iter.readI32() },
    ],
  });
