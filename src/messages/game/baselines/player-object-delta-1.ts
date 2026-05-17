/**
 * PlayerObject DELTAS_CLIENT_SERVER (packageId 1) — server-to-client.
 *
 * Delta counterpart to `PlayerObjectClientServerDecoder` (the baseline
 * decoder for the same `(typeId, packageId)` pair). Carries incremental
 * updates to the owner-only fields `bankBalance` and `cashBalance`.
 *
 * PlayerObject extends IntangibleObject extends ServerObject. PlayerObject
 * and IntangibleObject contribute zero auth-client fields to package 1, so
 * the only members are the two `ServerObject::addAuthClientServerVariable`
 * entries — identical in shape to TANO p1.
 *
 * Field order (matches `PlayerObjectClientServerBaseline`):
 *   index 0 — bankBalance (i32)
 *   index 1 — cashBalance (i32)
 *
 * Source for the field order:
 *   /home/tharper/code/swg-main/src/engine/server/library/serverGame/src/shared/generated/Packager.cpp:574-575
 *   (`ServerObject::addAuthClientServerVariable` adds bank then cash; no
 *   IntangibleObject or PlayerObject fields contribute to this package.)
 */

import { type DeltaPackageDecoder, registerDelta } from './delta-registry.js';
import type { PlayerObjectClientServerBaseline } from './player-object-baseline-1.js';
import { BaselinePackageIds, ObjectTypeTags } from './registry.js';

export const PlayerObjectClientServerDeltaKind = 'PlayerObjectClientServerDelta' as const;

export const PlayerObjectClientServerDeltaDecoder: DeltaPackageDecoder<PlayerObjectClientServerBaseline> =
  registerDelta<PlayerObjectClientServerBaseline>({
    kind: PlayerObjectClientServerDeltaKind,
    typeId: ObjectTypeTags.PLAY,
    packageId: BaselinePackageIds.CLIENT_SERVER,
    fields: [
      { name: 'bankBalance', decode: (iter) => iter.readI32() },
      { name: 'cashBalance', decode: (iter) => iter.readI32() },
    ],
  });
