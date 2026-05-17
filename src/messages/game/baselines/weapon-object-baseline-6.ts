/**
 * WeaponObject baseline package 6 (BASELINES_SHARED_NP) — server-to-client.
 *
 * The "SHARED_NP" baseline is sent to ALL clients but is NOT persisted to
 * the database (transient state).
 *
 * Member order:
 *
 *   ServerObject::addSharedVariable_np (2 fields):
 *     [u32]                                                  m_authServerProcessId
 *     [StringId]                                             m_descriptionStringId
 *
 *   TangibleObject::addSharedVariable_np (6 fields):
 *     [bool]                                                 m_inCombat
 *     [AutoDeltaSet<NetworkId>]                              m_passiveRevealPlayerCharacter
 *     [u32]                                                  m_mapColorOverride
 *     [AutoDeltaSet<NetworkId>]                              m_accessList
 *     [AutoDeltaSet<i32>]                                    m_guildAccessList
 *     [AutoDeltaMap<string, ...>]                            m_effectsMap
 *
 *   WeaponObject::addSharedVariable_np (1 field):
 *     [i32]                                                  m_weaponType
 *
 * Total: 9 members.
 *
 * Source:
 *   /home/tharper/code/swg-main/src/engine/server/library/serverGame/src/shared/generated/Packager.cpp
 *   lines 589-590 (ServerObject), 718-723 (TangibleObject), 758-759 (WeaponObject)
 */

import type { IReadIterator } from '../../../archive/interface.js';
import { readStdString } from '../../../archive/string.js';
import type { NetworkId, Vector3 } from '../../../types.js';
import { readAndCheckMemberCount } from './auto-byte-stream.js';
import {
  readAutoDeltaMap,
  readAutoDeltaSetI32,
  readAutoDeltaSetNetworkId,
} from './auto-delta-codecs.js';
import { BaselinePackageIds, ObjectTypeTags, registerBaseline } from './registry.js';
import { StringIdCodec, type StringIdValue } from './string-id.js';

export interface WeaponObjectEffect {
  name: string;
  effectScript: string;
  hardpoint: string;
  offset: Vector3;
  scale: number;
}

export interface WeaponObjectSharedNpBaseline {
  // From ServerObject
  authServerProcessId: number;
  descriptionStringId: StringIdValue;
  // From TangibleObject
  inCombat: boolean;
  passiveRevealPlayerCharacter: NetworkId[];
  mapColorOverride: number;
  accessList: NetworkId[];
  guildAccessList: number[];
  effects: WeaponObjectEffect[];
  // From WeaponObject
  /**
   * Weapon-type enum (see `WeaponObject::WeaponType` — pistol / rifle / carbine /
   * heavy / lightsaber / unarmed / etc.). Indexes into `weapon/weapon_data.iff`
   * client-side for behavior overrides.
   */
  weaponType: number;
}

export const WeaponObjectSharedNpKind = 'WeaponObjectSharedNp' as const;

const EXPECTED_MEMBER_COUNT = 9;

export const WeaponObjectSharedNpDecoder = registerBaseline<WeaponObjectSharedNpBaseline>({
  kind: WeaponObjectSharedNpKind,
  typeId: ObjectTypeTags.WEAO,
  packageId: BaselinePackageIds.SHARED_NP,
  expectedMemberCount: EXPECTED_MEMBER_COUNT,
  decode(iter: IReadIterator): WeaponObjectSharedNpBaseline {
    readAndCheckMemberCount(iter, EXPECTED_MEMBER_COUNT);
    // ServerObject
    const authServerProcessId = iter.readU32();
    const descriptionStringId = StringIdCodec.decode(iter);
    // TangibleObject
    const inCombat = iter.readBool();
    const passiveRevealPlayerCharacter = readAutoDeltaSetNetworkId(iter);
    const mapColorOverride = iter.readU32();
    const accessList = readAutoDeltaSetNetworkId(iter);
    const guildAccessList = readAutoDeltaSetI32(iter);
    const effects = readAutoDeltaMap(
      iter,
      readStdString,
      (i): { effectScript: string; hardpoint: string; offset: Vector3; scale: number } => {
        const effectScript = readStdString(i);
        const hardpoint = readStdString(i);
        const x = i.readF32();
        const y = i.readF32();
        const z = i.readF32();
        const scale = i.readF32();
        return { effectScript, hardpoint, offset: { x, y, z }, scale };
      },
    ).map((entry) => ({
      name: entry.key,
      effectScript: entry.value.effectScript,
      hardpoint: entry.value.hardpoint,
      offset: entry.value.offset,
      scale: entry.value.scale,
    }));
    // WeaponObject
    const weaponType = iter.readI32();
    return {
      authServerProcessId,
      descriptionStringId,
      inCombat,
      passiveRevealPlayerCharacter,
      mapColorOverride,
      accessList,
      guildAccessList,
      effects,
      weaponType,
    };
  },
});
