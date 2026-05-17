import { describe, expect, it } from 'vitest';

import { ByteStream } from '../../../archive/byte-stream.js';
import { NetworkIdCodec } from '../../../archive/network-id.js';
import { ReadIterator } from '../../../archive/read-iterator.js';
import { writeStdString } from '../../../archive/string.js';
import { writeMemberCount } from './auto-byte-stream.js';
import { WaypointCodec, type WaypointValue, WaypointColor } from './location.js';
import {
  type PlayerObjectFirstParentClientServerBaseline,
  PlayerObjectFirstParentClientServerDecoder,
  PlayerObjectFirstParentClientServerKind,
} from './player-object-baseline-8.js';
import { BaselinePackageIds, ObjectTypeTags, baselineRegistry } from './registry.js';

import './index.js';

function buildPayload(data: PlayerObjectFirstParentClientServerBaseline): Uint8Array {
  const s = new ByteStream();
  writeMemberCount(s, 9);
  // experiencePoints — AutoDeltaMap<string, i32>
  s.writeU32(data.experiencePoints.length);
  s.writeU32(0);
  for (const xp of data.experiencePoints) {
    s.writeU8(0); // ADD
    writeStdString(s, xp.category);
    s.writeI32(xp.amount);
  }
  // waypoints — AutoDeltaMap<NetworkId, Waypoint>
  s.writeU32(data.waypoints.length);
  s.writeU32(0);
  for (const wp of data.waypoints) {
    s.writeU8(0); // ADD
    NetworkIdCodec.encode(s, wp.id);
    WaypointCodec.encode(s, wp.waypoint);
  }
  s.writeI32(data.forcePower);
  s.writeI32(data.maxForcePower);
  // completedQuests — BitArray
  s.writeI32(data.completedQuests.bytes.length);
  s.writeI32(data.completedQuests.numInUseBits);
  s.writeBytes(data.completedQuests.bytes);
  // activeQuests — BitArray
  s.writeI32(data.activeQuests.bytes.length);
  s.writeI32(data.activeQuests.numInUseBits);
  s.writeBytes(data.activeQuests.bytes);
  s.writeU32(data.currentQuest);
  // quests — AutoDeltaMap<u32, PlayerQuestData>
  s.writeU32(data.quests.length);
  s.writeU32(0);
  for (const q of data.quests) {
    s.writeU8(0); // ADD
    s.writeU32(q.questCrc);
    NetworkIdCodec.encode(s, q.questGiver);
    s.writeU16(q.activeTasksMask);
    s.writeU16(q.completedTasksMask);
    s.writeBool(q.completed);
    s.writeU32(q.relativeAgeIndex);
    s.writeBool(q.hasReceivedReward);
  }
  writeStdString(s, data.workingSkill);
  return s.toBytes();
}

function emptyBitArray(): { numInUseBits: number; bytes: Uint8Array } {
  return { numInUseBits: 0, bytes: new Uint8Array(0) };
}

describe('PlayerObjectFirstParentClientServerDecoder', () => {
  it('is registered for (PLAY, FIRST_PARENT_CLIENT_SERVER=8)', () => {
    expect(PlayerObjectFirstParentClientServerDecoder.typeId).toBe(ObjectTypeTags.PLAY);
    expect(PlayerObjectFirstParentClientServerDecoder.packageId).toBe(
      BaselinePackageIds.FIRST_PARENT_CLIENT_SERVER,
    );
    expect(PlayerObjectFirstParentClientServerDecoder.kind).toBe(
      PlayerObjectFirstParentClientServerKind,
    );
    expect(PlayerObjectFirstParentClientServerDecoder.expectedMemberCount).toBe(9);
  });

  it('round-trips a baseline with XP categories, waypoint, and workingSkill', () => {
    const wp: WaypointValue = {
      appearanceNameCrc: 0,
      location: {
        coordinates: { x: 100, y: 5, z: 200 },
        cell: 0n,
        sceneIdCrc: 0xdeadbeef,
      },
      name: 'Mos Eisley Cantina',
      networkId: 0x1234n,
      color: WaypointColor.Blue,
      active: true,
    };
    const original: PlayerObjectFirstParentClientServerBaseline = {
      experiencePoints: [
        { category: 'combat_general', amount: 12345 },
        { category: 'crafting_artisan', amount: 6789 },
        { category: 'combat_brawler', amount: 0 },
      ],
      waypoints: [{ id: 0x1234n, waypoint: wp }],
      forcePower: 100,
      maxForcePower: 100,
      completedQuests: emptyBitArray(),
      activeQuests: emptyBitArray(),
      currentQuest: 0xabcd1234,
      quests: [
        {
          questCrc: 0x12345678,
          questGiver: 0xbeefn,
          activeTasksMask: 0x0001,
          completedTasksMask: 0x0000,
          completed: false,
          relativeAgeIndex: 7,
          hasReceivedReward: false,
        },
      ],
      workingSkill: 'class_domestics_phase1_novice',
    };
    const bytes = buildPayload(original);
    const iter = new ReadIterator(bytes);
    const decoded = PlayerObjectFirstParentClientServerDecoder.decode(iter);
    expect(decoded.experiencePoints).toHaveLength(3);
    expect(decoded.experiencePoints[0]).toEqual({ category: 'combat_general', amount: 12345 });
    expect(decoded.waypoints).toHaveLength(1);
    const wp0 = decoded.waypoints[0];
    expect(wp0?.id).toBe(0x1234n);
    expect(wp0?.waypoint.name).toBe('Mos Eisley Cantina');
    expect(decoded.forcePower).toBe(100);
    expect(decoded.maxForcePower).toBe(100);
    expect(decoded.currentQuest).toBe(0xabcd1234);
    expect(decoded.quests).toHaveLength(1);
    const q0 = decoded.quests[0];
    expect(q0?.questCrc).toBe(0x12345678);
    expect(q0?.questGiver).toBe(0xbeefn);
    expect(q0?.activeTasksMask).toBe(0x0001);
    expect(decoded.workingSkill).toBe('class_domestics_phase1_novice');
  });

  it('decodes a fresh-character baseline with no XP and no roadmap', () => {
    const original: PlayerObjectFirstParentClientServerBaseline = {
      experiencePoints: [],
      waypoints: [],
      forcePower: 0,
      maxForcePower: 0,
      completedQuests: emptyBitArray(),
      activeQuests: emptyBitArray(),
      currentQuest: 0,
      quests: [],
      workingSkill: '',
    };
    const bytes = buildPayload(original);
    const iter = new ReadIterator(bytes);
    const decoded = PlayerObjectFirstParentClientServerDecoder.decode(iter);
    expect(decoded.experiencePoints).toEqual([]);
    expect(decoded.workingSkill).toBe('');
  });

  it('found via baselineRegistry.get(PLAY, FIRST_PARENT_CLIENT_SERVER)', () => {
    const d = baselineRegistry.get(
      ObjectTypeTags.PLAY,
      BaselinePackageIds.FIRST_PARENT_CLIENT_SERVER,
    );
    expect(d).toBe(PlayerObjectFirstParentClientServerDecoder);
  });
});
