/**
 * CreatureObject baseline package 8 (BASELINES_FIRST_PARENT_CLIENT_SERVER) —
 * server-to-client.
 *
 * The "FIRST_PARENT_CLIENT_SERVER" baseline is sent to the auth client of the
 * object's FIRST_PARENT (root container — e.g. for a PlayerObject contained
 * inside a CreatureObject, the first-parent auth client is the player who
 * owns the creature).
 *
 * Looking at `Packager.cpp`:
 *   - ServerObject contributes 0 fields via `addFirstParentAuthClientServerVariable`.
 *   - TangibleObject contributes 0 fields.
 *   - CreatureObject contributes 0 fields.
 *   (PlayerObject DOES contribute 9 fields here — those land in PLAY p8.)
 *
 * So CREO p8 has NO fields — the baseline is an empty AutoByteStream with
 * `memberCount = 0`. The live wire flood shows 1 CREO p8 baseline arriving
 * during zone-in; this codec confirms it's a clean empty package.
 *
 * Member order: (none)
 *
 * Source:
 *   /home/tharper/code/swg-main/src/engine/server/library/serverGame/src/shared/generated/Packager.cpp
 *   lines 110-199 (CreatureObject — no `addFirstParentAuthClientServerVariable` calls)
 */

import type { IReadIterator } from '../../../archive/interface.js';
import { readAndCheckMemberCount } from './auto-byte-stream.js';
import { BaselinePackageIds, ObjectTypeTags, registerBaseline } from './registry.js';

export interface CreatureObjectFirstParentClientServerBaseline {
  // No fields — CREO p8 is an empty package.
  _empty: true;
}

export const CreatureObjectFirstParentClientServerKind =
  'CreatureObjectFirstParentClientServer' as const;

const EXPECTED_MEMBER_COUNT = 0;

export const CreatureObjectFirstParentClientServerDecoder =
  registerBaseline<CreatureObjectFirstParentClientServerBaseline>({
    kind: CreatureObjectFirstParentClientServerKind,
    typeId: ObjectTypeTags.CREO,
    packageId: BaselinePackageIds.FIRST_PARENT_CLIENT_SERVER,
    expectedMemberCount: EXPECTED_MEMBER_COUNT,
    decode(iter: IReadIterator): CreatureObjectFirstParentClientServerBaseline {
      readAndCheckMemberCount(iter, EXPECTED_MEMBER_COUNT);
      return { _empty: true };
    },
  });
