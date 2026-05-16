/**
 * PlayerObject baseline package 3 (BASELINES_SHARED) — server-to-client.
 *
 * PlayerObject is the "personality" half of a player character — it's an
 * IntangibleObject contained inside the CreatureObject (the visible body).
 * The SHARED baseline carries everything that's safe to expose to nearby
 * observers: title, played time, collections, etc.
 *
 * Member order (matches `addSharedVariable()` order):
 *
 *   ServerObject::addSharedVariable order (4 fields):
 *     [f32]            m_complexity
 *     [StringId]       m_nameStringId
 *     [Unicode::String] m_objectName
 *     [i32]            m_volume
 *
 *   IntangibleObject::addSharedVariable order (1 field):
 *     [i32]            m_count
 *
 *   PlayerObject::addSharedVariable order (15 fields):
 *     [MatchMakingId]  m_matchMakingCharacterProfileId   (128-bit bitset = 4 × i32 + count prefix)
 *     [MatchMakingId]  m_matchMakingPersonalProfileId
 *     [std::string]    m_skillTitle
 *     [i32]            m_bornDate                         (day-of-game-launch counter; 0 == unknown)
 *     [u32]            m_playedTime                       (cumulative seconds played, all sessions)
 *     [i32]            m_roleIconChoice
 *     [std::string]    m_skillTemplate
 *     [i32]            m_currentGcwPoints
 *     [i32]            m_currentPvpKills
 *     [i64]            m_lifetimeGcwPoints
 *     [i32]            m_lifetimePvpKills
 *     [BitArray]       m_collections                      ([i32 nBytes][i32 nBits][bytes])
 *     [BitArray]       m_collections2
 *     [bool]           m_showBackpack
 *     [bool]           m_showHelmet
 *
 * Total: 20 members.
 *
 * Source:
 *   /home/tharper/code/swg-main/src/engine/server/library/serverGame/src/shared/generated/Packager.cpp
 *   lines 295-308 (IntangibleObject) and 389-494 (PlayerObject — first 15 shared lines)
 */

import type { IReadIterator } from '../../../archive/interface.js';
import { readStdString } from '../../../archive/string.js';
import { readUnicodeString } from '../../../archive/unicode-string.js';
import { readAndCheckMemberCount } from './auto-byte-stream.js';
import {
  type BitArrayValue,
  type MatchMakingIdValue,
  readBitArray,
  readMatchMakingId,
} from './auto-delta-codecs.js';
import { BaselinePackageIds, ObjectTypeTags, registerBaseline } from './registry.js';
import { StringIdCodec, type StringIdValue } from './string-id.js';

export interface PlayerObjectSharedBaseline {
  // From ServerObject
  complexity: number;
  nameStringId: StringIdValue;
  objectName: string;
  volume: number;
  // From IntangibleObject
  count: number;
  // From PlayerObject
  matchMakingCharacterProfileId: MatchMakingIdValue;
  matchMakingPersonalProfileId: MatchMakingIdValue;
  /** Skill-derived title (e.g. "novice_brawler"). */
  skillTitle: string;
  /**
   * Day index relative to game launch when this character was created.
   * Multiply by ~86400 and offset by SWG's launch epoch for wall-clock time.
   * 0 means "unknown / not yet set".
   */
  bornDate: number;
  /** Cumulative seconds played across all sessions. */
  playedTime: number;
  roleIconChoice: number;
  /** Skill template name (e.g. "force_sensitive_combat_prowess_1handlightsaber_speed_03"). */
  skillTemplate: string;
  currentGcwPoints: number;
  currentPvpKills: number;
  /** i64 — exposed as bigint. */
  lifetimeGcwPoints: bigint;
  lifetimePvpKills: number;
  collections: BitArrayValue;
  collections2: BitArrayValue;
  showBackpack: boolean;
  showHelmet: boolean;
}

export const PlayerObjectSharedKind = 'PlayerObjectShared' as const;

const EXPECTED_MEMBER_COUNT = 20;

export const PlayerObjectSharedDecoder = registerBaseline<PlayerObjectSharedBaseline>({
  kind: PlayerObjectSharedKind,
  typeId: ObjectTypeTags.PLAY,
  packageId: BaselinePackageIds.SHARED,
  expectedMemberCount: EXPECTED_MEMBER_COUNT,
  decode(iter: IReadIterator): PlayerObjectSharedBaseline {
    readAndCheckMemberCount(iter, EXPECTED_MEMBER_COUNT);
    // ServerObject section
    const complexity = iter.readF32();
    const nameStringId = StringIdCodec.decode(iter);
    const objectName = readUnicodeString(iter);
    const volume = iter.readI32();
    // IntangibleObject section
    const count = iter.readI32();
    // PlayerObject section
    const matchMakingCharacterProfileId = readMatchMakingId(iter);
    const matchMakingPersonalProfileId = readMatchMakingId(iter);
    const skillTitle = readStdString(iter);
    const bornDate = iter.readI32();
    const playedTime = iter.readU32();
    const roleIconChoice = iter.readI32();
    const skillTemplate = readStdString(iter);
    const currentGcwPoints = iter.readI32();
    const currentPvpKills = iter.readI32();
    const lifetimeGcwPoints = iter.readI64();
    const lifetimePvpKills = iter.readI32();
    const collections = readBitArray(iter);
    const collections2 = readBitArray(iter);
    const showBackpack = iter.readBool();
    const showHelmet = iter.readBool();
    return {
      complexity,
      nameStringId,
      objectName,
      volume,
      count,
      matchMakingCharacterProfileId,
      matchMakingPersonalProfileId,
      skillTitle,
      bornDate,
      playedTime,
      roleIconChoice,
      skillTemplate,
      currentGcwPoints,
      currentPvpKills,
      lifetimeGcwPoints,
      lifetimePvpKills,
      collections,
      collections2,
      showBackpack,
      showHelmet,
    };
  },
});
