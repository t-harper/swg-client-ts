/**
 * CreatureObject baseline package 9 (BASELINES_FIRST_PARENT_CLIENT_SERVER_NP) —
 * server-to-client.
 *
 * The "FIRST_PARENT_CLIENT_SERVER_NP" baseline is the transient counterpart
 * of package 8 — sent to the auth client of the object's first parent,
 * carrying state that isn't persisted to the database.
 *
 * Looking at `Packager.cpp`:
 *   - ServerObject contributes 0 fields via `addFirstParentAuthClientServerVariable_np`.
 *   - TangibleObject contributes 0 fields.
 *   - CreatureObject contributes 0 fields.
 *   (PlayerObject DOES contribute 29 fields here — those land in PLAY p9.)
 *
 * So CREO p9 has NO fields — the baseline is an empty AutoByteStream with
 * `memberCount = 0`. The live wire flood shows 1 CREO p9 baseline arriving
 * during zone-in; this codec confirms it's a clean empty package.
 *
 * Member order: (none)
 *
 * Source:
 *   /home/tharper/code/swg-main/src/engine/server/library/serverGame/src/shared/generated/Packager.cpp
 *   lines 110-199 (CreatureObject — no `addFirstParentAuthClientServerVariable_np` calls)
 */

import type { IReadIterator } from '../../../archive/interface.js';
import { readAndCheckMemberCount } from './auto-byte-stream.js';
import { BaselinePackageIds, ObjectTypeTags, registerBaseline } from './registry.js';

export interface CreatureObjectFirstParentClientServerNpBaseline {
  // No fields — CREO p9 is an empty package.
  _empty: true;
}

export const CreatureObjectFirstParentClientServerNpKind =
  'CreatureObjectFirstParentClientServerNp' as const;

const EXPECTED_MEMBER_COUNT = 0;

export const CreatureObjectFirstParentClientServerNpDecoder =
  registerBaseline<CreatureObjectFirstParentClientServerNpBaseline>({
    kind: CreatureObjectFirstParentClientServerNpKind,
    typeId: ObjectTypeTags.CREO,
    packageId: BaselinePackageIds.FIRST_PARENT_CLIENT_SERVER_NP,
    expectedMemberCount: EXPECTED_MEMBER_COUNT,
    decode(iter: IReadIterator): CreatureObjectFirstParentClientServerNpBaseline {
      readAndCheckMemberCount(iter, EXPECTED_MEMBER_COUNT);
      return { _empty: true };
    },
  });
