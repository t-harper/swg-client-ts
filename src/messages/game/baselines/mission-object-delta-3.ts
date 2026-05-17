/**
 * MissionObject DELTAS_SHARED (packageId 3) — server-to-client.
 *
 * Delta counterpart to `MissionObjectSharedDecoder` (the baseline decoder
 * for the same `(typeId, packageId)` pair). Carries incremental updates to
 * any MissionObject's browser-card data after the initial baseline flood —
 * status flips (active -> complete/failed), reward bumps, waypoint shuffles
 * when a delivery target relocates, target re-rolls when a destroy mission
 * spawns its mob, etc. Mission terminals are the most common trigger; the
 * 5-7 MissionObjects in a player's mission bag tick through these as the
 * server periodically refreshes the list.
 *
 * Field order (matches `MissionObjectSharedBaseline.decode()` read order
 * exactly — see `mission-object-baseline-3.ts`):
 *
 *   ServerObject section (4 fields):
 *     index  0 — complexity        (f32)
 *     index  1 — nameStringId      (StringId)
 *     index  2 — objectName        (Unicode::String)
 *     index  3 — volume            (i32)
 *
 *   IntangibleObject section (1 field):
 *     index  4 — count             (i32)
 *
 *   MissionObject section (12 fields):
 *     index  5 — difficulty        (i32)
 *     index  6 — endLocation       (Location)
 *     index  7 — missionCreator    (Unicode::String)
 *     index  8 — reward            (i32)
 *     index  9 — startLocation     (Location)
 *     index 10 — targetAppearance  (u32)
 *     index 11 — description       (StringId)
 *     index 12 — title             (StringId)
 *     index 13 — status            (i32)
 *     index 14 — missionType       (u32)
 *     index 15 — targetName        (std::string)
 *     index 16 — waypoint          (Waypoint)
 *
 * Total: 17 fields, matching `MissionObjectSharedDecoder.expectedMemberCount`.
 *
 * None of the 17 fields are AutoDelta* containers — each is either a
 * primitive or a fixed-shape custom codec (StringId / Location / Waypoint /
 * Unicode::String / std::string), so every entry uses baseline-equivalent
 * reads. No `auto-delta-delta-codecs` helpers are needed here.
 *
 * Source for the field order:
 *   /home/tharper/code/swg-main/src/engine/server/library/serverGame/src/shared/generated/Packager.cpp
 *   lines 570-573 (ServerObject), 295-308 (IntangibleObject), 340-356 (MissionObject)
 */

import { readStdString } from '../../../archive/string.js';
import { readUnicodeString } from '../../../archive/unicode-string.js';
import { type DeltaPackageDecoder, registerDelta } from './delta-registry.js';
import { LocationCodec, WaypointCodec } from './location.js';
import type { MissionObjectSharedBaseline } from './mission-object-baseline-3.js';
import { BaselinePackageIds, ObjectTypeTags } from './registry.js';
import { StringIdCodec } from './string-id.js';

export const MissionObjectSharedDeltaKind = 'MissionObjectSharedDelta' as const;

export const MissionObjectSharedDeltaDecoder: DeltaPackageDecoder<MissionObjectSharedBaseline> =
  registerDelta<MissionObjectSharedBaseline>({
    kind: MissionObjectSharedDeltaKind,
    typeId: ObjectTypeTags.MISO,
    packageId: BaselinePackageIds.SHARED,
    fields: [
      // ServerObject section
      { name: 'complexity', decode: (iter) => iter.readF32() },
      { name: 'nameStringId', decode: (iter) => StringIdCodec.decode(iter) },
      { name: 'objectName', decode: (iter) => readUnicodeString(iter) },
      { name: 'volume', decode: (iter) => iter.readI32() },
      // IntangibleObject section
      { name: 'count', decode: (iter) => iter.readI32() },
      // MissionObject section
      { name: 'difficulty', decode: (iter) => iter.readI32() },
      { name: 'endLocation', decode: (iter) => LocationCodec.decode(iter) },
      { name: 'missionCreator', decode: (iter) => readUnicodeString(iter) },
      { name: 'reward', decode: (iter) => iter.readI32() },
      { name: 'startLocation', decode: (iter) => LocationCodec.decode(iter) },
      { name: 'targetAppearance', decode: (iter) => iter.readU32() },
      { name: 'description', decode: (iter) => StringIdCodec.decode(iter) },
      { name: 'title', decode: (iter) => StringIdCodec.decode(iter) },
      { name: 'status', decode: (iter) => iter.readI32() },
      { name: 'missionType', decode: (iter) => iter.readU32() },
      { name: 'targetName', decode: (iter) => readStdString(iter) },
      { name: 'waypoint', decode: (iter) => WaypointCodec.decode(iter) },
    ],
  });
