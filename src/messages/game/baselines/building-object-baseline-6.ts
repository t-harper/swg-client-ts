/**
 * BuildingObject baseline package 6 (BASELINES_SHARED_NP) — server-to-client.
 *
 * The "SHARED_NP" baseline is sent to ALL clients observing the object, but
 * the values are NOT persisted (runtime/transient). For buildings, this
 * carries TangibleObject's transient state (in-combat, map color override,
 * access list, guild access list, effects map, passive-reveal players) plus
 * ServerObject's two SharedNp fields (authServerProcessId, descriptionStringId).
 *
 * `BuildingObject extends TangibleObject extends ServerObject`. The
 * `addMembersToPackages` for `BuildingObject` adds NO shared_np variables
 * (the only `addServerVariable_np` it adds — `m_contentsLoaded` — is server-
 * private, not shared). So the SHARED_NP baseline contents are identical to
 * `TangibleObject` SHARED_NP — but the wire `typeId` is `BUIO` (the building
 * template tag), so it needs its own decoder registration to be queryable.
 *
 * Member order (inherited only — same as TangibleObject SHARED_NP):
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
 * Total: 8 members (2 + 6 + 0).
 *
 * Source (member adds):
 *   /home/tharper/code/swg-main/src/engine/server/library/serverGame/src/shared/generated/Packager.cpp
 *   lines 557-591 (ServerObject), 691-724 (TangibleObject), 64-73 (BuildingObject)
 *
 * Source (BuildingObject class):
 *   /home/tharper/code/swg-main/src/engine/server/library/serverGame/src/shared/object/BuildingObject.{h,cpp}
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

/**
 * One entry in the building's `m_effectsMap`. Shape mirrors
 * `TangibleObjectEffect` — buildings reuse Tangible's effects map verbatim.
 */
export interface BuildingObjectEffect {
  /** Effect name key (e.g. "structure_smoke_chimney"). */
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

export interface BuildingObjectSharedNpBaseline {
  // From ServerObject
  authServerProcessId: number;
  descriptionStringId: StringIdValue;
  // From TangibleObject
  inCombat: boolean;
  /** NetworkIds of player characters currently passively revealed to this building. */
  passiveRevealPlayerCharacter: NetworkId[];
  mapColorOverride: number;
  /** NetworkIds permitted to enter this building. */
  accessList: NetworkId[];
  /** Guild ids permitted to enter this building. */
  guildAccessList: number[];
  /** Active visual effects attached to this building. */
  effects: BuildingObjectEffect[];
}

export const BuildingObjectSharedNpKind = 'BuildingObjectSharedNp' as const;

const EXPECTED_MEMBER_COUNT = 8;

export const BuildingObjectSharedNpDecoder = registerBaseline<BuildingObjectSharedNpBaseline>({
  kind: BuildingObjectSharedNpKind,
  typeId: ObjectTypeTags.BUIO,
  packageId: BaselinePackageIds.SHARED_NP,
  expectedMemberCount: EXPECTED_MEMBER_COUNT,
  decode(iter: IReadIterator): BuildingObjectSharedNpBaseline {
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
        // pair<string, pair<string, pair<Vector, float>>> packs as A B C D E F
        // where A = effectScript, B = hardpoint, C-E = Vector(x,y,z), F = scale
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
