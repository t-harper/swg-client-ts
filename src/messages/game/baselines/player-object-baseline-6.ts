/**
 * PlayerObject baseline package 6 (BASELINES_SHARED_NP) — server-to-client.
 *
 * The "SHARED_NP" baseline is sent to ALL clients observing the object, but
 * the values are NOT persisted to the database (transient state like
 * "currently squelched until X" or "current GCW rank"). Same audience as
 * package 3 but different lifetime.
 *
 * Member order:
 *
 *   ServerObject::addSharedVariable_np order (2 fields):
 *     [u32]            m_authServerProcessId
 *     [StringId]       m_descriptionStringId
 *
 *   IntangibleObject::addSharedVariable_np order (0 fields)
 *
 *   PlayerObject::addSharedVariable_np order (15 fields):
 *     [i8]             m_privledgedTitle
 *     [i32]            m_currentGcwRank
 *     [f32]            m_currentGcwRankProgress
 *     [i32]            m_maxGcwImperialRank
 *     [i32]            m_maxGcwRebelRank
 *     [i32]            m_gcwRatingActualCalcTime
 *     [std::string]    m_citizenshipCity
 *     [i8]             m_citizenshipType                  (CityDataCitizenType enum)
 *     [GcwDefenderRegion] m_cityGcwDefenderRegion         (pair<string, pair<bool, bool>>)
 *     [GcwDefenderRegion] m_guildGcwDefenderRegion        (pair<string, pair<bool, bool>>)
 *     [NetworkId]      m_squelchedById                    (cms_invalid if not squelched)
 *     [std::string]    m_squelchedByName
 *     [i32]            m_squelchExpireTime                (Epoch time; < 0 = indefinite)
 *     [i32]            m_environmentFlags                 (Force Day/Night override bits)
 *     [std::string]    m_defaultAttackOverride
 *
 * Total: 17 members.
 *
 * Source:
 *   /home/tharper/code/swg-main/src/engine/server/library/serverGame/src/shared/generated/Packager.cpp
 *   lines 557-591 (ServerObject), 295-308 (IntangibleObject — no _np shared),
 *   441-455 (PlayerObject)
 */

import type { IReadIterator } from '../../../archive/interface.js';
import { NetworkIdCodec } from '../../../archive/network-id.js';
import { readStdString } from '../../../archive/string.js';
import type { NetworkId } from '../../../types.js';
import { readAndCheckMemberCount } from './auto-byte-stream.js';
import { BaselinePackageIds, ObjectTypeTags, registerBaseline } from './registry.js';
import { StringIdCodec, type StringIdValue } from './string-id.js';

export interface GcwDefenderRegion {
  /** GCW region name; empty if no defender region. */
  region: string;
  /** Qualifies for the region's GCW bonus. */
  qualifiesForBonus: boolean;
  /** Qualifies to use the "Region Defender" title. */
  qualifiesForTitle: boolean;
}

export interface PlayerObjectSharedNpBaseline {
  // From ServerObject
  authServerProcessId: number;
  descriptionStringId: StringIdValue;
  // From PlayerObject
  privledgedTitle: number;
  currentGcwRank: number;
  currentGcwRankProgress: number;
  maxGcwImperialRank: number;
  maxGcwRebelRank: number;
  gcwRatingActualCalcTime: number;
  /** Name of the city where the player has citizenship; empty if none. */
  citizenshipCity: string;
  /** CityDataCitizenType enum value. */
  citizenshipType: number;
  cityGcwDefenderRegion: GcwDefenderRegion;
  guildGcwDefenderRegion: GcwDefenderRegion;
  squelchedById: NetworkId;
  squelchedByName: string;
  /** Epoch seconds; < 0 = indefinite squelch. */
  squelchExpireTime: number;
  environmentFlags: number;
  defaultAttackOverride: string;
}

export const PlayerObjectSharedNpKind = 'PlayerObjectSharedNp' as const;

const EXPECTED_MEMBER_COUNT = 17;

function readGcwDefenderRegion(iter: IReadIterator): GcwDefenderRegion {
  // pair<A, pair<B, C>> packs as: [A][B][C] (pair pack is just A then B then C)
  const region = readStdString(iter);
  const qualifiesForBonus = iter.readBool();
  const qualifiesForTitle = iter.readBool();
  return { region, qualifiesForBonus, qualifiesForTitle };
}

export const PlayerObjectSharedNpDecoder = registerBaseline<PlayerObjectSharedNpBaseline>({
  kind: PlayerObjectSharedNpKind,
  typeId: ObjectTypeTags.PLAY,
  packageId: BaselinePackageIds.SHARED_NP,
  expectedMemberCount: EXPECTED_MEMBER_COUNT,
  decode(iter: IReadIterator): PlayerObjectSharedNpBaseline {
    readAndCheckMemberCount(iter, EXPECTED_MEMBER_COUNT);
    // ServerObject section
    const authServerProcessId = iter.readU32();
    const descriptionStringId = StringIdCodec.decode(iter);
    // PlayerObject section
    const privledgedTitle = iter.readI8();
    const currentGcwRank = iter.readI32();
    const currentGcwRankProgress = iter.readF32();
    const maxGcwImperialRank = iter.readI32();
    const maxGcwRebelRank = iter.readI32();
    const gcwRatingActualCalcTime = iter.readI32();
    const citizenshipCity = readStdString(iter);
    const citizenshipType = iter.readI8();
    const cityGcwDefenderRegion = readGcwDefenderRegion(iter);
    const guildGcwDefenderRegion = readGcwDefenderRegion(iter);
    const squelchedById = NetworkIdCodec.decode(iter);
    const squelchedByName = readStdString(iter);
    const squelchExpireTime = iter.readI32();
    const environmentFlags = iter.readI32();
    const defaultAttackOverride = readStdString(iter);
    return {
      authServerProcessId,
      descriptionStringId,
      privledgedTitle,
      currentGcwRank,
      currentGcwRankProgress,
      maxGcwImperialRank,
      maxGcwRebelRank,
      gcwRatingActualCalcTime,
      citizenshipCity,
      citizenshipType,
      cityGcwDefenderRegion,
      guildGcwDefenderRegion,
      squelchedById,
      squelchedByName,
      squelchExpireTime,
      environmentFlags,
      defaultAttackOverride,
    };
  },
});
