/**
 * PlayerObject baseline package 4 (BASELINES_CLIENT_SERVER_NP) — server-to-client.
 *
 * The "CLIENT_SERVER_NP" baseline is the AUTH-client-only, NOT-persisted
 * counterpart of package 1 — transient owner-only state.
 *
 * Looking at `Packager.cpp`:
 *   - ServerObject contributes 0 fields via `addAuthClientServerVariable_np`.
 *   - IntangibleObject contributes 0 fields.
 *   - PlayerObject contributes 0 fields — its transient owner state goes
 *     through `addServerVariable_np` (intra-server only) or
 *     `addFirstParentAuthClientServerVariable_np` (package 9, not 4).
 *
 * So PLAY p4 has NO fields — the baseline is an empty AutoByteStream with
 * `memberCount = 0` and nothing after it. The server sends the envelope
 * for completeness even though the package is structurally empty.
 *
 * Member order: (none)
 *
 * Source:
 *   /home/tharper/code/swg-main/src/engine/server/library/serverGame/src/shared/generated/Packager.cpp
 *   lines 389-494 (PlayerObject — no `addAuthClientServerVariable_np` calls)
 */

import type { IReadIterator } from '../../../archive/interface.js';
import { readAndCheckMemberCount } from './auto-byte-stream.js';
import { BaselinePackageIds, ObjectTypeTags, registerBaseline } from './registry.js';

export interface PlayerObjectClientServerNpBaseline {
  // No fields — PLAY p4 is an empty package.
  _empty: true;
}

export const PlayerObjectClientServerNpKind = 'PlayerObjectClientServerNp' as const;

const EXPECTED_MEMBER_COUNT = 0;

export const PlayerObjectClientServerNpDecoder =
  registerBaseline<PlayerObjectClientServerNpBaseline>({
    kind: PlayerObjectClientServerNpKind,
    typeId: ObjectTypeTags.PLAY,
    packageId: BaselinePackageIds.CLIENT_SERVER_NP,
    expectedMemberCount: EXPECTED_MEMBER_COUNT,
    decode(iter: IReadIterator): PlayerObjectClientServerNpBaseline {
      readAndCheckMemberCount(iter, EXPECTED_MEMBER_COUNT);
      return { _empty: true };
    },
  });
