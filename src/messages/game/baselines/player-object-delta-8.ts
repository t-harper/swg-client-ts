/**
 * PlayerObject DELTAS_FIRST_PARENT_CLIENT_SERVER (packageId 8) — server-to-client.
 *
 * Delta counterpart to `PlayerObjectFirstParentClientServerDecoder`. Carries
 * incremental updates to PlayerObject's persistent owner-only state:
 *   - `experiencePoints` map (one entry per XP grant)
 *   - `waypoints` map (waypoint add/remove)
 *   - `forcePower` / `maxForcePower` (Jedi only)
 *   - `completedQuests` / `activeQuests` (BitArray flips)
 *   - `currentQuest` (HUD-tracked quest CRC)
 *   - `quests` map (per-quest progress)
 *   - `workingSkill` (NGE roadmap selection)
 *
 * Field order matches `PlayerObjectFirstParentClientServerBaseline.decode()`.
 */

import { NetworkIdCodec } from '../../../archive/network-id.js';
import { readStdString } from '../../../archive/string.js';
import { readBitArray } from './auto-delta-codecs.js';
import { readAutoDeltaMapDelta } from './auto-delta-delta-codecs.js';
import { WaypointCodec } from './location.js';
import type { PlayerObjectFirstParentClientServerBaseline } from './player-object-baseline-8.js';
import { type DeltaPackageDecoder, registerDelta } from './delta-registry.js';
import { BaselinePackageIds, ObjectTypeTags } from './registry.js';

export const PlayerObjectFirstParentClientServerDeltaKind =
  'PlayerObjectFirstParentClientServerDelta' as const;

export const PlayerObjectFirstParentClientServerDeltaDecoder: DeltaPackageDecoder<PlayerObjectFirstParentClientServerBaseline> =
  registerDelta<PlayerObjectFirstParentClientServerBaseline>({
    kind: PlayerObjectFirstParentClientServerDeltaKind,
    typeId: ObjectTypeTags.PLAY,
    packageId: BaselinePackageIds.FIRST_PARENT_CLIENT_SERVER,
    fields: [
      {
        name: 'experiencePoints',
        decode: (iter) => readAutoDeltaMapDelta(iter, readStdString, (i) => i.readI32()),
      },
      {
        name: 'waypoints',
        decode: (iter) =>
          readAutoDeltaMapDelta(iter, NetworkIdCodec.decode, WaypointCodec.decode),
      },
      { name: 'forcePower', decode: (iter) => iter.readI32() },
      { name: 'maxForcePower', decode: (iter) => iter.readI32() },
      { name: 'completedQuests', decode: (iter) => readBitArray(iter) },
      { name: 'activeQuests', decode: (iter) => readBitArray(iter) },
      { name: 'currentQuest', decode: (iter) => iter.readU32() },
      {
        name: 'quests',
        decode: (iter) =>
          readAutoDeltaMapDelta(
            iter,
            (i) => i.readU32(),
            (i) => ({
              questGiver: NetworkIdCodec.decode(i),
              activeTasksMask: i.readU16(),
              completedTasksMask: i.readU16(),
              completed: i.readBool(),
              relativeAgeIndex: i.readU32(),
              hasReceivedReward: i.readBool(),
            }),
          ),
      },
      { name: 'workingSkill', decode: (iter) => readStdString(iter) },
    ],
  });
