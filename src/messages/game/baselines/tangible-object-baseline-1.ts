/**
 * TangibleObject baseline package 1 (BASELINES_CLIENT_SERVER) — server-to-client.
 *
 * The "CLIENT_SERVER" baseline is sent to the AUTH client (owner of the
 * object) only. For a tangible object, the auth client is typically the
 * player who owns the item.
 *
 * Looking at `Packager.cpp`:
 *   - ServerObject contributes 2 fields via `addAuthClientServerVariable`
 *     (`m_bankBalance`, `m_cashBalance`). These appear on every object that
 *     inherits from ServerObject — including TangibleObject — even though
 *     "bank balance" only makes intuitive sense for player characters.
 *   - TangibleObject contributes 0 fields via `addAuthClientServerVariable`.
 *
 * So TANO p1 = ServerObject's 2 auth-client fields only.
 *
 * NOTE: For non-player tangible objects (e.g. a sword, a container), the
 * bank/cash balance values will always be 0. For player CreatureObjects, the
 * CREO p1 baseline carries the meaningful balance (since CREO extends TANO and
 * gets its own version of this package).
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
 *   lines 574-575 (ServerObject — auth-client bank/cash)
 *   lines 691-724 (TangibleObject — note no `addAuthClientServerVariable` calls)
 */

import type { IReadIterator } from '../../../archive/interface.js';
import { readAndCheckMemberCount } from './auto-byte-stream.js';
import { BaselinePackageIds, ObjectTypeTags, registerBaseline } from './registry.js';

export interface TangibleObjectClientServerBaseline {
  /** Owner's bank balance in credits. Only meaningful for player creatures. */
  bankBalance: number;
  /** Owner's cash-on-hand balance in credits. Only meaningful for player creatures. */
  cashBalance: number;
}

export const TangibleObjectClientServerKind = 'TangibleObjectClientServer' as const;

const EXPECTED_MEMBER_COUNT = 2;

export const TangibleObjectClientServerDecoder =
  registerBaseline<TangibleObjectClientServerBaseline>({
    kind: TangibleObjectClientServerKind,
    typeId: ObjectTypeTags.TANO,
    packageId: BaselinePackageIds.CLIENT_SERVER,
    expectedMemberCount: EXPECTED_MEMBER_COUNT,
    decode(iter: IReadIterator): TangibleObjectClientServerBaseline {
      readAndCheckMemberCount(iter, EXPECTED_MEMBER_COUNT);
      const bankBalance = iter.readI32();
      const cashBalance = iter.readI32();
      return { bankBalance, cashBalance };
    },
  });
