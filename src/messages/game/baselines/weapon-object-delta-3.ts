/**
 * WeaponObject DELTAS_SHARED (packageId 3) — server-to-client.
 *
 * Delta counterpart to `WeaponObjectSharedDecoder`. Field order matches
 * the baseline decoder.
 */

import { readStdString } from '../../../archive/string.js';
import { readUnicodeString } from '../../../archive/unicode-string.js';
import { NetworkIdCodec } from '../../../archive/network-id.js';
import { readAutoDeltaVectorDelta } from './auto-delta-delta-codecs.js';
import { type DeltaPackageDecoder, registerDelta } from './delta-registry.js';
import { BaselinePackageIds, ObjectTypeTags } from './registry.js';
import { StringIdCodec } from './string-id.js';
import type { WeaponObjectSharedBaseline } from './weapon-object-baseline-3.js';

export const WeaponObjectSharedDeltaKind = 'WeaponObjectSharedDelta' as const;

export const WeaponObjectSharedDeltaDecoder: DeltaPackageDecoder<WeaponObjectSharedBaseline> =
  registerDelta<WeaponObjectSharedBaseline>({
    kind: WeaponObjectSharedDeltaKind,
    typeId: ObjectTypeTags.WEAO,
    packageId: BaselinePackageIds.SHARED,
    fields: [
      { name: 'complexity', decode: (iter) => iter.readF32() },
      { name: 'nameStringId', decode: (iter) => StringIdCodec.decode(iter) },
      { name: 'objectName', decode: (iter) => readUnicodeString(iter) },
      { name: 'volume', decode: (iter) => iter.readI32() },
      { name: 'pvpFaction', decode: (iter) => iter.readI32() },
      { name: 'pvpType', decode: (iter) => iter.readI32() },
      { name: 'appearanceData', decode: (iter) => readStdString(iter) },
      {
        name: 'components',
        decode: (iter) => readAutoDeltaVectorDelta(iter, NetworkIdCodec.decode),
      },
      { name: 'condition', decode: (iter) => iter.readI32() },
      { name: 'count', decode: (iter) => iter.readI32() },
      { name: 'damageTaken', decode: (iter) => iter.readI32() },
      { name: 'maxHitPoints', decode: (iter) => iter.readI32() },
      { name: 'visible', decode: (iter) => iter.readBool() },
      { name: 'attackSpeed', decode: (iter) => iter.readF32() },
      { name: 'accuracy', decode: (iter) => iter.readI32() },
      { name: 'minRange', decode: (iter) => iter.readF32() },
      { name: 'maxRange', decode: (iter) => iter.readF32() },
      { name: 'damageType', decode: (iter) => iter.readI32() },
      { name: 'elementalType', decode: (iter) => iter.readI32() },
      { name: 'elementalValue', decode: (iter) => iter.readI32() },
    ],
  });
