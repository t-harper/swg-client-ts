/**
 * CreatureObject DELTAS_CLIENT_SERVER_NP (packageId 4) — server-to-client.
 *
 * Delta counterpart to `CreatureObjectClientServerNpDecoder` (the baseline
 * decoder for the same `(typeId, packageId)` pair). Carries incremental
 * updates to the owner-only transient fields — most importantly `m_modMap`
 * (the calculated skill-mod stack the UI tooltips read from).
 *
 * Field order matches `CreatureObjectClientServerNpBaseline.decode()`.
 *
 * Source for the field order:
 *   /home/tharper/code/swg-main/src/engine/server/library/serverGame/src/shared/generated/Packager.cpp
 *   lines 183-198
 */

import { readStdString } from '../../../archive/string.js';
import { NetworkIdCodec } from '../../../archive/network-id.js';
import {
  readAutoDeltaMapDelta,
  readAutoDeltaSetDelta,
  readAutoDeltaVectorDelta,
} from './auto-delta-delta-codecs.js';
import type { CreatureObjectClientServerNpBaseline } from './creature-object-baseline-4.js';
import { type DeltaPackageDecoder, registerDelta } from './delta-registry.js';
import { BaselinePackageIds, ObjectTypeTags } from './registry.js';

export const CreatureObjectClientServerNpDeltaKind =
  'CreatureObjectClientServerNpDelta' as const;

export const CreatureObjectClientServerNpDeltaDecoder: DeltaPackageDecoder<CreatureObjectClientServerNpBaseline> =
  registerDelta<CreatureObjectClientServerNpBaseline>({
    kind: CreatureObjectClientServerNpDeltaKind,
    typeId: ObjectTypeTags.CREO,
    packageId: BaselinePackageIds.CLIENT_SERVER_NP,
    fields: [
      { name: 'accelPercent', decode: (iter) => iter.readF32() },
      { name: 'accelScale', decode: (iter) => iter.readF32() },
      {
        name: 'attribBonus',
        decode: (iter) => readAutoDeltaVectorDelta(iter, (i) => i.readI32()),
      },
      {
        name: 'modMap',
        decode: (iter) =>
          readAutoDeltaMapDelta(iter, readStdString, (i) => ({
            base: i.readI32(),
            bonus: i.readI32(),
          })),
      },
      { name: 'movementPercent', decode: (iter) => iter.readF32() },
      { name: 'movementScale', decode: (iter) => iter.readF32() },
      { name: 'performanceListenTarget', decode: (iter) => NetworkIdCodec.decode(iter) },
      { name: 'runSpeed', decode: (iter) => iter.readF32() },
      { name: 'slopeModAngle', decode: (iter) => iter.readF32() },
      { name: 'slopeModPercent', decode: (iter) => iter.readF32() },
      { name: 'turnScale', decode: (iter) => iter.readF32() },
      { name: 'walkSpeed', decode: (iter) => iter.readF32() },
      { name: 'waterModPercent', decode: (iter) => iter.readF32() },
      {
        name: 'groupMissionCriticalObjectSet',
        decode: (iter) =>
          readAutoDeltaSetDelta(iter, (i) => ({
            first: NetworkIdCodec.decode(i),
            second: NetworkIdCodec.decode(i),
          })),
      },
      {
        name: 'commands',
        decode: (iter) => readAutoDeltaMapDelta(iter, readStdString, (i) => i.readI32()),
      },
      { name: 'totalLevelXp', decode: (iter) => iter.readI32() },
    ],
  });
