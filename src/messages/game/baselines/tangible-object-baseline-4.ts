/**
 * TangibleObject baseline package 4 (BASELINES_CLIENT_SERVER_NP) — server-to-client.
 *
 * The "CLIENT_SERVER_NP" baseline is the AUTH-client-only, NOT-persisted
 * counterpart of package 1 — transient owner-only state.
 *
 * Looking at `Packager.cpp`:
 *   - ServerObject contributes 0 fields via `addAuthClientServerVariable_np`.
 *   - TangibleObject contributes 0 fields via `addAuthClientServerVariable_np`.
 *
 * So TANO p4 has NO fields — the baseline is an empty AutoByteStream with
 * `memberCount = 0` and nothing after it. The server still sends the
 * envelope for symmetry with CREO p4 (CreatureObject's auth-client-np
 * package adds many real fields and CREO extends TANO, so the wire layout
 * inherits TANO's empty section first).
 *
 * NOTE: An empty package is a valid AutoByteStream. `memberCount = 0`
 * is allowed by `AutoByteStream::pack`.
 *
 * Member order: (none)
 *
 * Source:
 *   /home/tharper/code/swg-main/src/engine/server/library/serverGame/src/shared/generated/Packager.cpp
 *   lines 557-591 (ServerObject — no `addAuthClientServerVariable_np` calls)
 *   lines 691-724 (TangibleObject — no `addAuthClientServerVariable_np` calls)
 */

import type { IReadIterator } from '../../../archive/interface.js';
import { readAndCheckMemberCount } from './auto-byte-stream.js';
import { BaselinePackageIds, ObjectTypeTags, registerBaseline } from './registry.js';

export interface TangibleObjectClientServerNpBaseline {
  // No fields — TANO p4 is an empty package.
  _empty: true;
}

export const TangibleObjectClientServerNpKind = 'TangibleObjectClientServerNp' as const;

const EXPECTED_MEMBER_COUNT = 0;

export const TangibleObjectClientServerNpDecoder =
  registerBaseline<TangibleObjectClientServerNpBaseline>({
    kind: TangibleObjectClientServerNpKind,
    typeId: ObjectTypeTags.TANO,
    packageId: BaselinePackageIds.CLIENT_SERVER_NP,
    expectedMemberCount: EXPECTED_MEMBER_COUNT,
    decode(iter: IReadIterator): TangibleObjectClientServerNpBaseline {
      readAndCheckMemberCount(iter, EXPECTED_MEMBER_COUNT);
      return { _empty: true };
    },
  });
