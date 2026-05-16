import { describe, expect, it } from 'vitest';

import { ByteStream } from '../../../archive/byte-stream.js';
import { ReadIterator } from '../../../archive/read-iterator.js';
import { writeStdString } from '../../../archive/string.js';
import { writeUnicodeString } from '../../../archive/unicode-string.js';
import { writeMemberCount } from './auto-byte-stream.js';
import {
  type CreatureObjectSharedBaseline,
  CreatureObjectSharedDecoder,
  CreatureObjectSharedKind,
} from './creature-object-baseline-3.js';
import { BaselinePackageIds, ObjectTypeTags, baselineRegistry } from './registry.js';
import { StringIdCodec } from './string-id.js';

import './index.js';

/** Build a CreatureObject baseline 3 payload byte-by-byte. */
function buildPayload(data: CreatureObjectSharedBaseline): Uint8Array {
  const s = new ByteStream();
  writeMemberCount(s, 19);
  // ServerObject section
  s.writeF32(data.complexity);
  StringIdCodec.encode(s, data.nameStringId);
  writeUnicodeString(s, data.objectName);
  s.writeI32(data.volume);
  // TangibleObject section
  s.writeU32(data.pvpFaction);
  s.writeI32(data.pvpType);
  writeStdString(s, data.appearanceData);
  // AutoDeltaSet<int>: [u32 size][u32 baselineCommandCount=0][values]
  s.writeU32(data.components.length);
  s.writeU32(0);
  for (const v of data.components) s.writeI32(v);
  s.writeI32(data.condition);
  s.writeI32(data.count);
  s.writeI32(data.damageTaken);
  s.writeI32(data.maxHitPoints);
  s.writeBool(data.visible);
  // CreatureObject section
  s.writeI8(data.posture);
  s.writeU8(data.rank);
  s.writeI64(data.masterId);
  s.writeF32(data.scaleFactor);
  s.writeI32(data.shockWounds);
  s.writeU64(data.states);
  return s.toBytes();
}

describe('CreatureObjectSharedDecoder', () => {
  it('is registered for (CREO, SHARED=3)', () => {
    expect(CreatureObjectSharedDecoder.typeId).toBe(ObjectTypeTags.CREO);
    expect(CreatureObjectSharedDecoder.packageId).toBe(BaselinePackageIds.SHARED);
    expect(CreatureObjectSharedDecoder.kind).toBe(CreatureObjectSharedKind);
    expect(CreatureObjectSharedDecoder.expectedMemberCount).toBe(19);
  });

  it('round-trips a realistic creature baseline (mos eisley spawn)', () => {
    const original: CreatureObjectSharedBaseline = {
      complexity: 1,
      nameStringId: { table: 'first_names', textIndex: 0, text: 'A_Heroic' },
      objectName: 'TsTest',
      volume: 1,
      pvpFaction: 0,
      pvpType: 0,
      appearanceData: '',
      components: [],
      condition: 0,
      count: 0,
      damageTaken: 0,
      maxHitPoints: 1000,
      visible: true,
      posture: 0, // Upright
      rank: 0,
      masterId: 0n,
      scaleFactor: 1.0,
      shockWounds: 0,
      states: 0n,
    };
    const bytes = buildPayload(original);
    const iter = new ReadIterator(bytes);
    const decoded = CreatureObjectSharedDecoder.decode(iter);
    expect(decoded.complexity).toBeCloseTo(1);
    expect(decoded.nameStringId).toEqual({
      table: 'first_names',
      textIndex: 0,
      text: 'A_Heroic',
    });
    expect(decoded.objectName).toBe('TsTest');
    expect(decoded.maxHitPoints).toBe(1000);
    expect(decoded.visible).toBe(true);
    expect(decoded.posture).toBe(0);
    expect(decoded.scaleFactor).toBeCloseTo(1.0);
    expect(decoded.masterId).toBe(0n);
    expect(decoded.states).toBe(0n);
  });

  it('round-trips a non-default posture, scale, master, and combat states', () => {
    const original: CreatureObjectSharedBaseline = {
      complexity: 5,
      nameStringId: { table: '', textIndex: 0, text: '' },
      objectName: 'Stormtrooper Lieutenant',
      volume: 1,
      pvpFaction: 0xdeadbeef,
      pvpType: 1,
      appearanceData: '/appearance/stormtrooper_lt.iff',
      components: [42, 100, 7],
      condition: 0x0001, // C_onOff
      count: 1,
      damageTaken: 50,
      maxHitPoints: 5000,
      visible: true,
      posture: 8, // Sitting
      rank: 3, // some rank
      masterId: 0x0123_4567_89ab_cdefn,
      scaleFactor: 1.5,
      shockWounds: 200,
      states: 0x0000_0001_0000_0002n, // some combat state bits
    };
    const bytes = buildPayload(original);
    const iter = new ReadIterator(bytes);
    const decoded = CreatureObjectSharedDecoder.decode(iter);
    expect(decoded.objectName).toBe('Stormtrooper Lieutenant');
    expect(decoded.appearanceData).toBe('/appearance/stormtrooper_lt.iff');
    expect(decoded.components).toEqual([42, 100, 7]);
    expect(decoded.posture).toBe(8);
    expect(decoded.rank).toBe(3);
    expect(decoded.masterId).toBe(0x0123_4567_89ab_cdefn);
    expect(decoded.scaleFactor).toBeCloseTo(1.5);
    expect(decoded.shockWounds).toBe(200);
    expect(decoded.states).toBe(0x0000_0001_0000_0002n);
  });

  it('round-trips a dead creature with negative posture rare edge', () => {
    const original: CreatureObjectSharedBaseline = {
      complexity: 0,
      nameStringId: { table: '', textIndex: 0, text: '' },
      objectName: '',
      volume: 0,
      pvpFaction: 0,
      pvpType: 0,
      appearanceData: '',
      components: [],
      condition: 0,
      count: 0,
      damageTaken: 9999,
      maxHitPoints: 1000,
      visible: true,
      posture: 14, // Dead
      rank: 0,
      masterId: 0n,
      scaleFactor: 1,
      shockWounds: 0,
      states: 0n,
    };
    const bytes = buildPayload(original);
    const iter = new ReadIterator(bytes);
    const decoded = CreatureObjectSharedDecoder.decode(iter);
    expect(decoded.posture).toBe(14);
    expect(decoded.damageTaken).toBe(9999);
  });

  it('found via baselineRegistry.get(CREO, SHARED)', () => {
    const d = baselineRegistry.get(ObjectTypeTags.CREO, BaselinePackageIds.SHARED);
    expect(d).toBe(CreatureObjectSharedDecoder);
  });
});
