/**
 * TangibleObject baseline package 6 (BASELINES_SHARED_NP) — server-to-client.
 *
 * The "SHARED_NP" baseline is sent to ALL clients observing the object, but
 * the values are NOT persisted to the database (transient state like "in
 * combat right now" or "active visual effects").
 *
 * Member order:
 *
 *   ServerObject::addSharedVariable_np order (2 fields):
 *     [u32]                m_authServerProcessId
 *     [StringId]           m_descriptionStringId
 *
 *   TangibleObject::addSharedVariable_np order (6 fields):
 *     [bool]               m_inCombat
 *     [AutoDeltaSet<NetworkId>] m_passiveRevealPlayerCharacter
 *     [u32]                m_mapColorOverride
 *     [AutoDeltaSet<NetworkId>] m_accessList
 *     [AutoDeltaSet<int>]  m_guildAccessList
 *     [AutoDeltaMap<string, pair<string, pair<string, pair<Vector, float>>>>] m_effectsMap
 *
 * Total: 8 members.
 *
 * Source:
 *   /home/tharper/code/swg-main/src/engine/server/library/serverGame/src/shared/generated/Packager.cpp
 *   lines 557-591 (ServerObject) and 689-724 (TangibleObject)
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

export interface TangibleObjectEffect {
  /** Effect name key (e.g. "kashyyyk_armor_glow"). */
  name: string;
  /** Effect script/data identifier (1st pair element). */
  effectScript: string;
  /** Hardpoint or attachment node name (2nd pair element). */
  hardpoint: string;
  /** Offset from hardpoint, in world units. */
  offset: Vector3;
  /** Scale factor. */
  scale: number;
}

export interface TangibleObjectSharedNpBaseline {
  // From ServerObject
  authServerProcessId: number;
  descriptionStringId: StringIdValue;
  // From TangibleObject
  inCombat: boolean;
  /** NetworkIds of player characters currently passively revealed to this object. */
  passiveRevealPlayerCharacter: NetworkId[];
  mapColorOverride: number;
  /** NetworkIds permitted to enter this object (cells/buildings/etc). */
  accessList: NetworkId[];
  /** Guild ids permitted to enter this object. */
  guildAccessList: number[];
  /** Active visual effects attached to this object. */
  effects: TangibleObjectEffect[];
}

export const TangibleObjectSharedNpKind = 'TangibleObjectSharedNp' as const;

const EXPECTED_MEMBER_COUNT = 8;

export const TangibleObjectSharedNpDecoder = registerBaseline<TangibleObjectSharedNpBaseline>({
  kind: TangibleObjectSharedNpKind,
  typeId: ObjectTypeTags.TANO,
  packageId: BaselinePackageIds.SHARED_NP,
  expectedMemberCount: EXPECTED_MEMBER_COUNT,
  decode(iter: IReadIterator): TangibleObjectSharedNpBaseline {
    readAndCheckMemberCount(iter, EXPECTED_MEMBER_COUNT);
    // ServerObject section
    const authServerProcessId = iter.readU32();
    const descriptionStringId = StringIdCodec.decode(iter);
    // TangibleObject section
    const inCombat = iter.readBool();
    const passiveRevealPlayerCharacter = readAutoDeltaSetNetworkId(iter);
    const mapColorOverride = iter.readU32();
    const accessList = readAutoDeltaSetNetworkId(iter);
    const guildAccessList = readAutoDeltaSetI32(iter);
    const effects = readAutoDeltaMap(
      iter,
      readStdString,
      (i): { effectScript: string; hardpoint: string; offset: Vector3; scale: number } => {
        // pair<string, pair<string, pair<Vector, float>>> packs as A B C D E
        // where A = first string, B = second string, C-E = Vector(x,y,z), F = float
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
    return {
      authServerProcessId,
      descriptionStringId,
      inCombat,
      passiveRevealPlayerCharacter,
      mapColorOverride,
      accessList,
      guildAccessList,
      effects,
    };
  },
});
