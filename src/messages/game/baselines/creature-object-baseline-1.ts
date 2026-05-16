/**
 * CreatureObject baseline package 1 (BASELINES_CLIENT_SERVER) — server-to-client.
 *
 * The "CLIENT_SERVER" baseline is sent to the AUTH client (owner of the
 * object) only. For a CreatureObject, this is the player whose character
 * this is, carrying owner-only persistent state: bank/cash, max attributes,
 * and skill list.
 *
 * Member order (matches `Packager.cpp::ServerObject::addMembersToPackages`,
 * then `TangibleObject::addMembersToPackages` (no fields), then
 * `CreatureObject::addMembersToPackages`):
 *
 *   ServerObject::addAuthClientServerVariable order (2 fields):
 *     [i32]            m_bankBalance
 *     [i32]            m_cashBalance
 *
 *   TangibleObject::addAuthClientServerVariable order (0 fields)
 *
 *   CreatureObject::addAuthClientServerVariable order (2 fields):
 *     [AutoDeltaVector<i32>] m_maxAttributes   (Attributes::Value = int — 6 entries)
 *     [AutoDeltaSet<SkillObject*>] m_skills    (each SkillObject* packs as std::string skill name)
 *
 * Total: 4 members (2 from ServerObject + 2 from CreatureObject).
 *
 * Source:
 *   /home/tharper/code/swg-main/src/engine/server/library/serverGame/src/shared/generated/Packager.cpp
 *   lines 125-126 (CreatureObject — 2 auth-client fields)
 *   lines 574-575 (ServerObject)
 *
 * Source for types:
 *   /home/tharper/code/swg-main/src/engine/server/library/serverGame/src/shared/object/CreatureObject.h:838,914
 *   /home/tharper/code/swg-main/src/engine/shared/library/sharedSkillSystem/src/shared/SkillObjectArchive.cpp
 *     (SkillObject* serializes as `std::string` of the skill name; empty string == nullptr)
 */

import type { IReadIterator } from '../../../archive/interface.js';
import { readAndCheckMemberCount } from './auto-byte-stream.js';
import { readAutoDeltaSetString, readAutoDeltaVectorI32 } from './auto-delta-codecs.js';
import { BaselinePackageIds, ObjectTypeTags, registerBaseline } from './registry.js';

export interface CreatureObjectClientServerBaseline {
  // From ServerObject
  bankBalance: number;
  cashBalance: number;
  // From CreatureObject
  /**
   * Max unmodified attribute values, one per Attributes::Enumerator slot
   * (Health, Constitution, Action, Stamina, Mind, Willpower — 6 entries).
   */
  maxAttributes: number[];
  /**
   * Names of all skills this creature has trained. Empty string indicates a
   * `SkillObject*` nullptr that the server should have filtered out — present
   * only as a defensive measure.
   */
  skills: string[];
}

export const CreatureObjectClientServerKind = 'CreatureObjectClientServer' as const;

const EXPECTED_MEMBER_COUNT = 4;

export const CreatureObjectClientServerDecoder =
  registerBaseline<CreatureObjectClientServerBaseline>({
    kind: CreatureObjectClientServerKind,
    typeId: ObjectTypeTags.CREO,
    packageId: BaselinePackageIds.CLIENT_SERVER,
    expectedMemberCount: EXPECTED_MEMBER_COUNT,
    decode(iter: IReadIterator): CreatureObjectClientServerBaseline {
      readAndCheckMemberCount(iter, EXPECTED_MEMBER_COUNT);
      // ServerObject section
      const bankBalance = iter.readI32();
      const cashBalance = iter.readI32();
      // CreatureObject section
      const maxAttributes = readAutoDeltaVectorI32(iter);
      const skills = readAutoDeltaSetString(iter);
      return {
        bankBalance,
        cashBalance,
        maxAttributes,
        skills,
      };
    },
  });
