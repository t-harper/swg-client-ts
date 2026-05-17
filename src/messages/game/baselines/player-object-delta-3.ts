/**
 * PlayerObject DELTAS_SHARED (packageId 3) — server-to-client.
 *
 * Delta counterpart to `PlayerObjectSharedDecoder` (the baseline decoder
 * for the same `(typeId, packageId)` pair). Carries incremental updates
 * to the SHARED package of any PlayerObject — the intangible "personality"
 * sibling of a CreatureObject. Anything observable to other clients
 * (title, played time, collections progress, helmet/backpack toggle)
 * flows through here.
 *
 * Field order (matches `PlayerObjectSharedBaseline.decode()`):
 *
 *   From ServerObject:
 *     index 0  — complexity                    (f32)
 *     index 1  — nameStringId                  (StringId)
 *     index 2  — objectName                    (UnicodeString)
 *     index 3  — volume                        (i32)
 *
 *   From IntangibleObject:
 *     index 4  — count                         (i32)
 *
 *   From PlayerObject:
 *     index 5  — matchMakingCharacterProfileId (MatchMakingId)
 *     index 6  — matchMakingPersonalProfileId  (MatchMakingId)
 *     index 7  — skillTitle                    (std::string)
 *     index 8  — bornDate                      (i32)
 *     index 9  — playedTime                    (u32)
 *     index 10 — roleIconChoice                (i32)
 *     index 11 — skillTemplate                 (std::string)
 *     index 12 — currentGcwPoints              (i32)
 *     index 13 — currentPvpKills               (i32)
 *     index 14 — lifetimeGcwPoints             (i64)
 *     index 15 — lifetimePvpKills              (i32)
 *     index 16 — collections                   (BitArray)
 *     index 17 — collections2                  (BitArray)
 *     index 18 — showBackpack                  (bool)
 *     index 19 — showHelmet                    (bool)
 *
 * None of the 20 fields are AutoDelta* containers — each is either a
 * primitive or a fixed-shape custom codec, so all 20 entries use
 * baseline-equivalent reads.
 *
 * Source for the field order:
 *   /home/tharper/code/swg-main/src/engine/server/library/serverGame/src/shared/generated/Packager.cpp
 *   lines 295-308 (IntangibleObject) and 389-494 (PlayerObject shared)
 */

import { readStdString } from '../../../archive/string.js';
import { readUnicodeString } from '../../../archive/unicode-string.js';
import { readBitArray, readMatchMakingId } from './auto-delta-codecs.js';
import { type DeltaPackageDecoder, registerDelta } from './delta-registry.js';
import type { PlayerObjectSharedBaseline } from './player-object-baseline-3.js';
import { BaselinePackageIds, ObjectTypeTags } from './registry.js';
import { StringIdCodec } from './string-id.js';

export const PlayerObjectSharedDeltaKind = 'PlayerObjectSharedDelta' as const;

export const PlayerObjectSharedDeltaDecoder: DeltaPackageDecoder<PlayerObjectSharedBaseline> =
  registerDelta<PlayerObjectSharedBaseline>({
    kind: PlayerObjectSharedDeltaKind,
    typeId: ObjectTypeTags.PLAY,
    packageId: BaselinePackageIds.SHARED,
    fields: [
      // ServerObject section
      { name: 'complexity', decode: (iter) => iter.readF32() },
      { name: 'nameStringId', decode: (iter) => StringIdCodec.decode(iter) },
      { name: 'objectName', decode: (iter) => readUnicodeString(iter) },
      { name: 'volume', decode: (iter) => iter.readI32() },
      // IntangibleObject section
      { name: 'count', decode: (iter) => iter.readI32() },
      // PlayerObject section
      { name: 'matchMakingCharacterProfileId', decode: (iter) => readMatchMakingId(iter) },
      { name: 'matchMakingPersonalProfileId', decode: (iter) => readMatchMakingId(iter) },
      { name: 'skillTitle', decode: (iter) => readStdString(iter) },
      { name: 'bornDate', decode: (iter) => iter.readI32() },
      { name: 'playedTime', decode: (iter) => iter.readU32() },
      { name: 'roleIconChoice', decode: (iter) => iter.readI32() },
      { name: 'skillTemplate', decode: (iter) => readStdString(iter) },
      { name: 'currentGcwPoints', decode: (iter) => iter.readI32() },
      { name: 'currentPvpKills', decode: (iter) => iter.readI32() },
      { name: 'lifetimeGcwPoints', decode: (iter) => iter.readI64() },
      { name: 'lifetimePvpKills', decode: (iter) => iter.readI32() },
      { name: 'collections', decode: (iter) => readBitArray(iter) },
      { name: 'collections2', decode: (iter) => readBitArray(iter) },
      { name: 'showBackpack', decode: (iter) => iter.readBool() },
      { name: 'showHelmet', decode: (iter) => iter.readBool() },
    ],
  });
