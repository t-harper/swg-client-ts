import { describe, expect, it } from 'vitest';

import { ByteStream } from '../../../archive/byte-stream.js';
import { NetworkIdCodec } from '../../../archive/network-id.js';
import { ReadIterator } from '../../../archive/read-iterator.js';
import { writeStdString } from '../../../archive/string.js';
import { writeUnicodeString } from '../../../archive/unicode-string.js';
import { writeMemberCount } from './auto-byte-stream.js';
import { BaselinePackageIds, ObjectTypeTags, baselineRegistry } from './registry.js';
import { StringIdCodec } from './string-id.js';
import {
  type WeaponObjectSharedBaseline,
  WeaponObjectSharedDecoder,
  WeaponObjectSharedKind,
} from './weapon-object-baseline-3.js';

import './index.js';

function buildPayload(data: WeaponObjectSharedBaseline): Uint8Array {
  const s = new ByteStream();
  writeMemberCount(s, 20);
  // ServerObject
  s.writeF32(data.complexity);
  StringIdCodec.encode(s, data.nameStringId);
  writeUnicodeString(s, data.objectName);
  s.writeI32(data.volume);
  // TangibleObject
  s.writeI32(data.pvpFaction);
  s.writeI32(data.pvpType);
  writeStdString(s, data.appearanceData);
  s.writeU32(data.components.length);
  s.writeU32(0);
  for (const id of data.components) NetworkIdCodec.encode(s, id);
  s.writeI32(data.condition);
  s.writeI32(data.count);
  s.writeI32(data.damageTaken);
  s.writeI32(data.maxHitPoints);
  s.writeBool(data.visible);
  // WeaponObject
  s.writeF32(data.attackSpeed);
  s.writeI32(data.accuracy);
  s.writeF32(data.minRange);
  s.writeF32(data.maxRange);
  s.writeI32(data.damageType);
  s.writeI32(data.elementalType);
  s.writeI32(data.elementalValue);
  return s.toBytes();
}

describe('WeaponObjectSharedDecoder', () => {
  it('is registered for (WEAO, SHARED=3)', () => {
    expect(WeaponObjectSharedDecoder.typeId).toBe(ObjectTypeTags.WEAO);
    expect(WeaponObjectSharedDecoder.packageId).toBe(BaselinePackageIds.SHARED);
    expect(WeaponObjectSharedDecoder.kind).toBe(WeaponObjectSharedKind);
    expect(WeaponObjectSharedDecoder.expectedMemberCount).toBe(20);
  });

  it('round-trips a typical melee weapon', () => {
    const original: WeaponObjectSharedBaseline = {
      complexity: 1,
      nameStringId: { table: 'item_n', textIndex: 0, text: 'vibroblade' },
      objectName: '',
      volume: 1,
      pvpFaction: 0,
      pvpType: 0,
      appearanceData: '',
      components: [],
      condition: 1000,
      count: 0,
      damageTaken: 0,
      maxHitPoints: 1000,
      visible: true,
      attackSpeed: 4.0,
      accuracy: 10,
      minRange: 0,
      maxRange: 4,
      damageType: 1,
      elementalType: 0,
      elementalValue: 0,
    };
    const bytes = buildPayload(original);
    const iter = new ReadIterator(bytes);
    const decoded = WeaponObjectSharedDecoder.decode(iter);
    expect(decoded.attackSpeed).toBeCloseTo(4.0, 5);
    expect(decoded.maxRange).toBeCloseTo(4, 5);
    expect(decoded.accuracy).toBe(10);
    expect(decoded.damageType).toBe(1);
  });

  it('round-trips a typical ranged weapon with elemental damage', () => {
    const original: WeaponObjectSharedBaseline = {
      complexity: 1,
      nameStringId: { table: 'weapon_n', textIndex: 0, text: 'rifle_e11' },
      objectName: '',
      volume: 1,
      pvpFaction: 0,
      pvpType: 0,
      appearanceData: '',
      components: [],
      condition: 1000,
      count: 0,
      damageTaken: 0,
      maxHitPoints: 1000,
      visible: true,
      attackSpeed: 2.5,
      accuracy: 25,
      minRange: 2,
      maxRange: 64,
      damageType: 2,
      elementalType: 3,
      elementalValue: 150,
    };
    const bytes = buildPayload(original);
    const iter = new ReadIterator(bytes);
    const decoded = WeaponObjectSharedDecoder.decode(iter);
    expect(decoded.maxRange).toBe(64);
    expect(decoded.elementalType).toBe(3);
    expect(decoded.elementalValue).toBe(150);
  });

  it('found via baselineRegistry.get(WEAO, SHARED)', () => {
    const d = baselineRegistry.get(ObjectTypeTags.WEAO, BaselinePackageIds.SHARED);
    expect(d).toBe(WeaponObjectSharedDecoder);
  });
});
