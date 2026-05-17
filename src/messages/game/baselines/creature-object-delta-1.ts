/**
 * CreatureObject DELTAS_CLIENT_SERVER (packageId 1) — server-to-client.
 *
 * Delta counterpart to `CreatureObjectClientServerDecoder` (the baseline
 * decoder for the same `(typeId, packageId)` pair). Carries incremental
 * updates to the owner-only fields that change frequently on a player
 * character: bank/cash balance, max-attribute caps, and the trained-skill
 * set.
 *
 * Field order (matches `CreatureObjectClientServerBaseline.decode()`):
 *   index 0 — bankBalance   (i32)                          [from ServerObject]
 *   index 1 — cashBalance   (i32)                          [from ServerObject]
 *   index 2 — maxAttributes (AutoDeltaVector<i32>)         [from CreatureObject]
 *   index 3 — skills        (AutoDeltaSet<std::string>)    [from CreatureObject]
 *
 * Source for the field order:
 *   /home/tharper/code/swg-main/src/engine/server/library/serverGame/src/shared/generated/Packager.cpp
 *   lines 574-575 (ServerObject auth-client: bank then cash)
 *   lines 125-126 (CreatureObject auth-client: maxAttributes then skills)
 */

import { readStdString } from '../../../archive/string.js';
import { readAutoDeltaSetDelta, readAutoDeltaVectorDelta } from './auto-delta-delta-codecs.js';
import type { CreatureObjectClientServerBaseline } from './creature-object-baseline-1.js';
import { type DeltaPackageDecoder, registerDelta } from './delta-registry.js';
import { BaselinePackageIds, ObjectTypeTags } from './registry.js';

export const CreatureObjectClientServerDeltaKind = 'CreatureObjectClientServerDelta' as const;

export const CreatureObjectClientServerDeltaDecoder: DeltaPackageDecoder<CreatureObjectClientServerBaseline> =
  registerDelta<CreatureObjectClientServerBaseline>({
    kind: CreatureObjectClientServerDeltaKind,
    typeId: ObjectTypeTags.CREO,
    packageId: BaselinePackageIds.CLIENT_SERVER,
    fields: [
      { name: 'bankBalance', decode: (iter) => iter.readI32() },
      { name: 'cashBalance', decode: (iter) => iter.readI32() },
      {
        name: 'maxAttributes',
        decode: (iter) => readAutoDeltaVectorDelta(iter, (i) => i.readI32()),
      },
      {
        name: 'skills',
        decode: (iter) => readAutoDeltaSetDelta(iter, readStdString),
      },
    ],
  });
