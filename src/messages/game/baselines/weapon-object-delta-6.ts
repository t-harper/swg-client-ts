/**
 * WeaponObject DELTAS_SHARED_NP (packageId 6) — server-to-client.
 *
 * Delta counterpart to `WeaponObjectSharedNpDecoder`. Field order matches
 * the baseline decoder.
 */

import { NetworkIdCodec } from '../../../archive/network-id.js';
import { readStdString } from '../../../archive/string.js';
import {
  readAutoDeltaMapDelta,
  readAutoDeltaSetDelta,
} from './auto-delta-delta-codecs.js';
import { type DeltaPackageDecoder, registerDelta } from './delta-registry.js';
import { BaselinePackageIds, ObjectTypeTags } from './registry.js';
import { StringIdCodec } from './string-id.js';
import type { WeaponObjectSharedNpBaseline } from './weapon-object-baseline-6.js';

export const WeaponObjectSharedNpDeltaKind = 'WeaponObjectSharedNpDelta' as const;

export const WeaponObjectSharedNpDeltaDecoder: DeltaPackageDecoder<WeaponObjectSharedNpBaseline> =
  registerDelta<WeaponObjectSharedNpBaseline>({
    kind: WeaponObjectSharedNpDeltaKind,
    typeId: ObjectTypeTags.WEAO,
    packageId: BaselinePackageIds.SHARED_NP,
    fields: [
      { name: 'authServerProcessId', decode: (iter) => iter.readU32() },
      { name: 'descriptionStringId', decode: (iter) => StringIdCodec.decode(iter) },
      { name: 'inCombat', decode: (iter) => iter.readBool() },
      {
        name: 'passiveRevealPlayerCharacter',
        decode: (iter) => readAutoDeltaSetDelta(iter, NetworkIdCodec.decode),
      },
      { name: 'mapColorOverride', decode: (iter) => iter.readU32() },
      {
        name: 'accessList',
        decode: (iter) => readAutoDeltaSetDelta(iter, NetworkIdCodec.decode),
      },
      {
        name: 'guildAccessList',
        decode: (iter) => readAutoDeltaSetDelta(iter, (i) => i.readI32()),
      },
      {
        name: 'effects',
        decode: (iter) =>
          readAutoDeltaMapDelta(iter, readStdString, (i) => {
            const effectScript = readStdString(i);
            const hardpoint = readStdString(i);
            const x = i.readF32();
            const y = i.readF32();
            const z = i.readF32();
            const scale = i.readF32();
            return { effectScript, hardpoint, offset: { x, y, z }, scale };
          }),
      },
      { name: 'weaponType', decode: (iter) => iter.readI32() },
    ],
  });
