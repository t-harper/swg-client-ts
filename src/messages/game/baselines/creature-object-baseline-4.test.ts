import { describe, expect, it } from 'vitest';

import { ByteStream } from '../../../archive/byte-stream.js';
import { NetworkIdCodec } from '../../../archive/network-id.js';
import { ReadIterator } from '../../../archive/read-iterator.js';
import { writeStdString } from '../../../archive/string.js';
import { writeMemberCount } from './auto-byte-stream.js';
import {
  type CreatureObjectClientServerNpBaseline,
  CreatureObjectClientServerNpDecoder,
  CreatureObjectClientServerNpKind,
} from './creature-object-baseline-4.js';
import { BaselinePackageIds, ObjectTypeTags, baselineRegistry } from './registry.js';

import './index.js';

function buildPayload(data: CreatureObjectClientServerNpBaseline): Uint8Array {
  const s = new ByteStream();
  writeMemberCount(s, 16);
  s.writeF32(data.accelPercent);
  s.writeF32(data.accelScale);
  // attribBonus — AutoDeltaVector<i32>
  s.writeU32(data.attribBonus.length);
  s.writeU32(0);
  for (const v of data.attribBonus) s.writeI32(v);
  // modMap — AutoDeltaMap<string, pair<i32,i32>>
  s.writeU32(data.modMap.length);
  s.writeU32(0);
  for (const entry of data.modMap) {
    s.writeU8(0); // ADD
    writeStdString(s, entry.name);
    s.writeI32(entry.base);
    s.writeI32(entry.bonus);
  }
  s.writeF32(data.movementPercent);
  s.writeF32(data.movementScale);
  NetworkIdCodec.encode(s, data.performanceListenTarget);
  s.writeF32(data.runSpeed);
  s.writeF32(data.slopeModAngle);
  s.writeF32(data.slopeModPercent);
  s.writeF32(data.turnScale);
  s.writeF32(data.walkSpeed);
  s.writeF32(data.waterModPercent);
  // groupMissionCriticalObjectSet — AutoDeltaSet<pair<NetworkId,NetworkId>>
  s.writeU32(data.groupMissionCriticalObjectSet.length);
  s.writeU32(0);
  for (const p of data.groupMissionCriticalObjectSet) {
    NetworkIdCodec.encode(s, p.first);
    NetworkIdCodec.encode(s, p.second);
  }
  // commands — AutoDeltaMap<string, i32>
  s.writeU32(data.commands.length);
  s.writeU32(0);
  for (const c of data.commands) {
    s.writeU8(0); // ADD
    writeStdString(s, c.name);
    s.writeI32(c.level);
  }
  s.writeI32(data.totalLevelXp);
  return s.toBytes();
}

describe('CreatureObjectClientServerNpDecoder', () => {
  it('is registered for (CREO, CLIENT_SERVER_NP=4)', () => {
    expect(CreatureObjectClientServerNpDecoder.typeId).toBe(ObjectTypeTags.CREO);
    expect(CreatureObjectClientServerNpDecoder.packageId).toBe(
      BaselinePackageIds.CLIENT_SERVER_NP,
    );
    expect(CreatureObjectClientServerNpDecoder.kind).toBe(CreatureObjectClientServerNpKind);
    expect(CreatureObjectClientServerNpDecoder.expectedMemberCount).toBe(16);
  });

  it('round-trips a baseline with skillMods + commands populated', () => {
    const original: CreatureObjectClientServerNpBaseline = {
      accelPercent: 1.0,
      accelScale: 1.0,
      attribBonus: [10, 0, 5, 0, 0, 0],
      modMap: [
        { name: 'pistol_accuracy', base: 75, bonus: 12 },
        { name: 'strength_modified', base: 100, bonus: 0 },
        { name: 'agility_modified', base: 50, bonus: 25 },
      ],
      movementPercent: 1.0,
      movementScale: 1.0,
      performanceListenTarget: 0n,
      runSpeed: 7.3,
      slopeModAngle: 45.0,
      slopeModPercent: 0.5,
      turnScale: 1.0,
      walkSpeed: 1.65,
      waterModPercent: 0.5,
      groupMissionCriticalObjectSet: [],
      commands: [
        { name: 'survey', level: 0 },
        { name: 'pistol', level: 0 },
      ],
      totalLevelXp: 12345,
    };
    const bytes = buildPayload(original);
    const iter = new ReadIterator(bytes);
    const decoded = CreatureObjectClientServerNpDecoder.decode(iter);
    expect(decoded.modMap).toHaveLength(3);
    expect(decoded.modMap[0]).toEqual({ name: 'pistol_accuracy', base: 75, bonus: 12 });
    expect(decoded.modMap[2]).toEqual({ name: 'agility_modified', base: 50, bonus: 25 });
    expect(decoded.commands).toHaveLength(2);
    expect(decoded.commands[0]).toEqual({ name: 'survey', level: 0 });
    expect(decoded.totalLevelXp).toBe(12345);
    expect(decoded.attribBonus).toEqual([10, 0, 5, 0, 0, 0]);
    expect(decoded.runSpeed).toBeCloseTo(7.3, 5);
  });

  it('decodes an empty modMap when the player has no skills', () => {
    const original: CreatureObjectClientServerNpBaseline = {
      accelPercent: 1,
      accelScale: 1,
      attribBonus: [],
      modMap: [],
      movementPercent: 1,
      movementScale: 1,
      performanceListenTarget: 0n,
      runSpeed: 7.3,
      slopeModAngle: 45,
      slopeModPercent: 0.5,
      turnScale: 1,
      walkSpeed: 1.65,
      waterModPercent: 0.5,
      groupMissionCriticalObjectSet: [],
      commands: [],
      totalLevelXp: 0,
    };
    const bytes = buildPayload(original);
    const iter = new ReadIterator(bytes);
    const decoded = CreatureObjectClientServerNpDecoder.decode(iter);
    expect(decoded.modMap).toEqual([]);
    expect(decoded.commands).toEqual([]);
  });

  it('found via baselineRegistry.get(CREO, CLIENT_SERVER_NP)', () => {
    const d = baselineRegistry.get(ObjectTypeTags.CREO, BaselinePackageIds.CLIENT_SERVER_NP);
    expect(d).toBe(CreatureObjectClientServerNpDecoder);
  });
});
