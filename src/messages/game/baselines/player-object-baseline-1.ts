/**
 * PlayerObject baseline package 1 (BASELINES_CLIENT_SERVER) — server-to-client.
 *
 * The "CLIENT_SERVER" baseline is sent to the AUTH client (owner of the
 * object) only — never to nearby observers. It carries the auth-client-only
 * subset of the object's persisted state.
 *
 * PlayerObject extends IntangibleObject extends ServerObject. Looking at
 * `Packager.cpp` for the three classes:
 *   - ServerObject contributes 2 fields via `addAuthClientServerVariable`
 *     (`m_bankBalance`, `m_cashBalance`).
 *   - IntangibleObject contributes 0 auth-client fields.
 *   - PlayerObject contributes 0 auth-client fields — all of its persisted
 *     state goes through `addServerVariable` (intra-server) or
 *     `addFirstParentAuthClientServerVariable` (which is package 8, not 1).
 *
 * So PLAY p1 = the same 2 fields as TANO p1 (the ServerObject base contribution).
 *
 * Member order:
 *   ServerObject::addAuthClientServerVariable order (2 fields):
 *     [i32]            m_bankBalance
 *     [i32]            m_cashBalance
 *
 * Total: 2 members.
 *
 * Source:
 *   /home/tharper/code/swg-main/src/engine/server/library/serverGame/src/shared/generated/Packager.cpp
 *   lines 389-494 (PlayerObject — note no `addAuthClientServerVariable` calls)
 *   lines 574-575 (ServerObject — auth-client bank/cash)
 *
 * Source for types:
 *   /home/tharper/code/swg-main/src/engine/server/library/serverGame/src/shared/object/ServerObject.h:811-812
 */

import type { IReadIterator } from '../../../archive/interface.js';
import { readAndCheckMemberCount } from './auto-byte-stream.js';
import { BaselinePackageIds, ObjectTypeTags, registerBaseline } from './registry.js';

export interface PlayerObjectClientServerBaseline {
  // From ServerObject
  /** Owner's bank balance in credits (the wallet at any bank terminal). */
  bankBalance: number;
  /** Owner's cash-on-hand balance in credits (the wallet carried around). */
  cashBalance: number;
}

export const PlayerObjectClientServerKind = 'PlayerObjectClientServer' as const;

const EXPECTED_MEMBER_COUNT = 2;

export const PlayerObjectClientServerDecoder = registerBaseline<PlayerObjectClientServerBaseline>({
  kind: PlayerObjectClientServerKind,
  typeId: ObjectTypeTags.PLAY,
  packageId: BaselinePackageIds.CLIENT_SERVER,
  expectedMemberCount: EXPECTED_MEMBER_COUNT,
  decode(iter: IReadIterator): PlayerObjectClientServerBaseline {
    readAndCheckMemberCount(iter, EXPECTED_MEMBER_COUNT);
    // ServerObject section
    const bankBalance = iter.readI32();
    const cashBalance = iter.readI32();
    return {
      bankBalance,
      cashBalance,
    };
  },
});
