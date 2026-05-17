import { describe, expect, it } from 'vitest';

import { ByteStream } from '../../../archive/byte-stream.js';
import { ReadIterator } from '../../../archive/read-iterator.js';
import { writeMemberCount } from './auto-byte-stream.js';
import { BaselinePackageIds, ObjectTypeTags, baselineRegistry } from './registry.js';
import { StringIdCodec } from './string-id.js';
import {
  type WeaponObjectSharedNpBaseline,
  WeaponObjectSharedNpDecoder,
  WeaponObjectSharedNpKind,
} from './weapon-object-baseline-6.js';

import './index.js';

function buildPayload(data: WeaponObjectSharedNpBaseline): Uint8Array {
  const s = new ByteStream();
  writeMemberCount(s, 9);
  // ServerObject
  s.writeU32(data.authServerProcessId);
  StringIdCodec.encode(s, data.descriptionStringId);
  // TangibleObject
  s.writeBool(data.inCombat);
  s.writeU32(data.passiveRevealPlayerCharacter.length);
  s.writeU32(0);
  s.writeU32(data.mapColorOverride);
  s.writeU32(data.accessList.length);
  s.writeU32(0);
  s.writeU32(data.guildAccessList.length);
  s.writeU32(0);
  s.writeU32(data.effects.length);
  s.writeU32(0);
  // WeaponObject
  s.writeI32(data.weaponType);
  return s.toBytes();
}

describe('WeaponObjectSharedNpDecoder', () => {
  it('is registered for (WEAO, SHARED_NP=6)', () => {
    expect(WeaponObjectSharedNpDecoder.typeId).toBe(ObjectTypeTags.WEAO);
    expect(WeaponObjectSharedNpDecoder.packageId).toBe(BaselinePackageIds.SHARED_NP);
    expect(WeaponObjectSharedNpDecoder.kind).toBe(WeaponObjectSharedNpKind);
    expect(WeaponObjectSharedNpDecoder.expectedMemberCount).toBe(9);
  });

  it('round-trips a weapon with no effects and weaponType=3', () => {
    const original: WeaponObjectSharedNpBaseline = {
      authServerProcessId: 0,
      descriptionStringId: { table: '', textIndex: 0, text: '' },
      inCombat: false,
      passiveRevealPlayerCharacter: [],
      mapColorOverride: 0,
      accessList: [],
      guildAccessList: [],
      effects: [],
      weaponType: 3, // pistol
    };
    const bytes = buildPayload(original);
    const iter = new ReadIterator(bytes);
    const decoded = WeaponObjectSharedNpDecoder.decode(iter);
    expect(decoded.weaponType).toBe(3);
    expect(decoded.effects).toEqual([]);
  });

  it('found via baselineRegistry.get(WEAO, SHARED_NP)', () => {
    const d = baselineRegistry.get(ObjectTypeTags.WEAO, BaselinePackageIds.SHARED_NP);
    expect(d).toBe(WeaponObjectSharedNpDecoder);
  });
});
