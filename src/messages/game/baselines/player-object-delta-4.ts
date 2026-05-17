/**
 * PlayerObject DELTAS_CLIENT_SERVER_NP (packageId 4) — server-to-client.
 *
 * Delta counterpart to `PlayerObjectClientServerNpDecoder` (the baseline
 * decoder for the same `(typeId, packageId)` pair).
 *
 * PLAY p4 is the AUTH-client-only, NOT-persisted package — transient
 * owner-only state. Looking at `Packager.cpp`:
 *   - ServerObject contributes 0 fields via `addAuthClientServerVariable_np`.
 *   - IntangibleObject contributes 0 fields.
 *   - PlayerObject contributes 0 fields — its transient owner state goes
 *     through `addServerVariable_np` (intra-server only) or
 *     `addFirstParentAuthClientServerVariable_np` (package 9, not 4).
 *
 * So PLAY p4 has NO fields — the matching baseline is an empty AutoByteStream
 * with `memberCount = 0`. By extension, ANY delta packet for this package can
 * carry at most an empty `[u16 count=0]` payload; any non-zero fieldIndex is
 * out of range and `tryDecodeDelta` will swallow the throw and return `null`.
 *
 * We register the decoder anyway so the `(PLAY, p4)` slot is occupied —
 * without this, `tryDecodeDelta` would return `null` (no decoder) for the
 * empty-payload case too, which is indistinguishable from a real wire-format
 * drift on the receiving side.
 *
 * Field order: (none) — `fields: []`
 *
 * Source for the field order:
 *   /home/tharper/code/swg-main/src/engine/server/library/serverGame/src/shared/generated/Packager.cpp
 *   lines 389-494 (PlayerObject — no `addAuthClientServerVariable_np` calls)
 *   lines 557-595 (ServerObject — no `addAuthClientServerVariable_np` calls)
 *   lines 295-308 (IntangibleObject — no `addAuthClientServerVariable_np` calls)
 */

import { type DeltaPackageDecoder, registerDelta } from './delta-registry.js';
import type { PlayerObjectClientServerNpBaseline } from './player-object-baseline-4.js';
import { BaselinePackageIds, ObjectTypeTags } from './registry.js';

export const PlayerObjectClientServerNpDeltaKind = 'PlayerObjectClientServerNpDelta' as const;

export const PlayerObjectClientServerNpDeltaDecoder: DeltaPackageDecoder<PlayerObjectClientServerNpBaseline> =
  registerDelta<PlayerObjectClientServerNpBaseline>({
    kind: PlayerObjectClientServerNpDeltaKind,
    typeId: ObjectTypeTags.PLAY,
    packageId: BaselinePackageIds.CLIENT_SERVER_NP,
    fields: [],
  });
