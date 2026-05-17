/**
 * PlayerObject DELTAS_SHARED_NP (packageId 6) — server-to-client.
 *
 * Delta counterpart to `PlayerObjectSharedNpDecoder` (the baseline decoder for
 * the same `(typeId, packageId)` pair). Carries incremental updates to the
 * publicly-visible-but-non-persistent PlayerObject fields — squelch state
 * changes, GCW rank/progress ticks, citizenship updates, force day/night
 * environment overrides, etc.
 *
 * Field order (matches `PlayerObjectSharedNpBaseline.decode()` read order
 * exactly — see `player-object-baseline-6.ts`):
 *
 *   ServerObject section (2 fields):
 *     index  0 — authServerProcessId        (u32)
 *     index  1 — descriptionStringId        (StringId)
 *
 *   IntangibleObject section (0 fields)
 *
 *   PlayerObject section (15 fields):
 *     index  2 — privledgedTitle            (i8)
 *     index  3 — currentGcwRank             (i32)
 *     index  4 — currentGcwRankProgress     (f32)
 *     index  5 — maxGcwImperialRank         (i32)
 *     index  6 — maxGcwRebelRank            (i32)
 *     index  7 — gcwRatingActualCalcTime    (i32)
 *     index  8 — citizenshipCity            (std::string)
 *     index  9 — citizenshipType            (i8)
 *     index 10 — cityGcwDefenderRegion      (GcwDefenderRegion: [string][bool][bool])
 *     index 11 — guildGcwDefenderRegion     (GcwDefenderRegion: [string][bool][bool])
 *     index 12 — squelchedById              (NetworkId i64)
 *     index 13 — squelchedByName            (std::string)
 *     index 14 — squelchExpireTime          (i32)
 *     index 15 — environmentFlags           (i32)
 *     index 16 — defaultAttackOverride      (std::string)
 *
 * Total: 17 fields, matching `PlayerObjectSharedNpDecoder.expectedMemberCount`.
 *
 * Source for field order:
 *   /home/tharper/code/swg-main/src/engine/server/library/serverGame/src/shared/generated/Packager.cpp
 *   lines 557-591 (ServerObject), 441-455 (PlayerObject)
 *
 * # No AutoDelta* container fields
 *
 * Every field in this package is a primitive or a fixed-shape codec
 * (StringId / NetworkId / GcwDefenderRegion). No AutoDeltaVector / Set / Map
 * commands appear; deltas always carry whole-field replacement values.
 */

import type { IReadIterator } from '../../../archive/interface.js';
import { NetworkIdCodec } from '../../../archive/network-id.js';
import { readStdString } from '../../../archive/string.js';
import { type DeltaPackageDecoder, registerDelta } from './delta-registry.js';
import type {
  GcwDefenderRegion,
  PlayerObjectSharedNpBaseline,
} from './player-object-baseline-6.js';
import { BaselinePackageIds, ObjectTypeTags } from './registry.js';
import { StringIdCodec } from './string-id.js';

export const PlayerObjectSharedNpDeltaKind = 'PlayerObjectSharedNpDelta' as const;

function readGcwDefenderRegion(iter: IReadIterator): GcwDefenderRegion {
  // pair<A, pair<B, C>> packs as: [A][B][C] (pair pack is just A then B then C)
  const region = readStdString(iter);
  const qualifiesForBonus = iter.readBool();
  const qualifiesForTitle = iter.readBool();
  return { region, qualifiesForBonus, qualifiesForTitle };
}

export const PlayerObjectSharedNpDeltaDecoder: DeltaPackageDecoder<PlayerObjectSharedNpBaseline> =
  registerDelta<PlayerObjectSharedNpBaseline>({
    kind: PlayerObjectSharedNpDeltaKind,
    typeId: ObjectTypeTags.PLAY,
    packageId: BaselinePackageIds.SHARED_NP,
    fields: [
      // ServerObject section
      { name: 'authServerProcessId', decode: (iter) => iter.readU32() },
      { name: 'descriptionStringId', decode: StringIdCodec.decode },
      // PlayerObject section
      { name: 'privledgedTitle', decode: (iter) => iter.readI8() },
      { name: 'currentGcwRank', decode: (iter) => iter.readI32() },
      { name: 'currentGcwRankProgress', decode: (iter) => iter.readF32() },
      { name: 'maxGcwImperialRank', decode: (iter) => iter.readI32() },
      { name: 'maxGcwRebelRank', decode: (iter) => iter.readI32() },
      { name: 'gcwRatingActualCalcTime', decode: (iter) => iter.readI32() },
      { name: 'citizenshipCity', decode: readStdString },
      { name: 'citizenshipType', decode: (iter) => iter.readI8() },
      { name: 'cityGcwDefenderRegion', decode: readGcwDefenderRegion },
      { name: 'guildGcwDefenderRegion', decode: readGcwDefenderRegion },
      { name: 'squelchedById', decode: NetworkIdCodec.decode },
      { name: 'squelchedByName', decode: readStdString },
      { name: 'squelchExpireTime', decode: (iter) => iter.readI32() },
      { name: 'environmentFlags', decode: (iter) => iter.readI32() },
      { name: 'defaultAttackOverride', decode: readStdString },
    ],
  });
