import { describe, expect, it } from 'vitest';

import { ByteStream } from '../../../archive/byte-stream.js';
import { ReadIterator } from '../../../archive/read-iterator.js';
import { writeStdString } from '../../../archive/string.js';
import { writeUnicodeString } from '../../../archive/unicode-string.js';
import { writeMemberCount } from './auto-byte-stream.js';
import { LocationCodec, WaypointCodec, WaypointColor } from './location.js';
import {
  type MissionObjectSharedBaseline,
  MissionObjectSharedDecoder,
  MissionObjectSharedKind,
} from './mission-object-baseline-3.js';
import { BaselinePackageIds, ObjectTypeTags, baselineRegistry } from './registry.js';
import { StringIdCodec } from './string-id.js';

import './index.js';

/** Build a MissionObject SHARED baseline payload byte-by-byte from `data`. */
function buildPayload(data: MissionObjectSharedBaseline): Uint8Array {
  const s = new ByteStream();
  writeMemberCount(s, 17);
  // ServerObject section
  s.writeF32(data.complexity);
  StringIdCodec.encode(s, data.nameStringId);
  writeUnicodeString(s, data.objectName);
  s.writeI32(data.volume);
  // IntangibleObject section
  s.writeI32(data.count);
  // MissionObject section
  s.writeI32(data.difficulty);
  LocationCodec.encode(s, data.endLocation);
  writeUnicodeString(s, data.missionCreator);
  s.writeI32(data.reward);
  LocationCodec.encode(s, data.startLocation);
  s.writeU32(data.targetAppearance);
  StringIdCodec.encode(s, data.description);
  StringIdCodec.encode(s, data.title);
  s.writeI32(data.status);
  s.writeU32(data.missionType);
  writeStdString(s, data.targetName);
  WaypointCodec.encode(s, data.waypoint);
  return s.toBytes();
}

const TATOOINE_SCENE_CRC = 0x12345678;

describe('MissionObjectSharedDecoder', () => {
  it('is registered for (MISO, SHARED=3)', () => {
    expect(MissionObjectSharedDecoder.typeId).toBe(ObjectTypeTags.MISO);
    expect(MissionObjectSharedDecoder.packageId).toBe(BaselinePackageIds.SHARED);
    expect(MissionObjectSharedDecoder.kind).toBe(MissionObjectSharedKind);
    expect(MissionObjectSharedDecoder.expectedMemberCount).toBe(17);
  });

  it('is found via baselineRegistry.get(MISO, SHARED)', () => {
    const d = baselineRegistry.get(ObjectTypeTags.MISO, BaselinePackageIds.SHARED);
    expect(d).toBe(MissionObjectSharedDecoder);
  });

  it('round-trips a realistic "destroy 5 womp rats" mission', () => {
    const original: MissionObjectSharedBaseline = {
      complexity: 1,
      nameStringId: { table: '', textIndex: 0, text: '' },
      objectName: '',
      volume: 1,
      count: 0,
      difficulty: 5,
      endLocation: {
        coordinates: { x: -1234, y: 5, z: 4567 },
        cell: 0n,
        sceneIdCrc: TATOOINE_SCENE_CRC,
      },
      missionCreator: 'Tibik the Hutt',
      reward: 1500,
      startLocation: {
        coordinates: { x: 0, y: 5, z: 0 },
        cell: 0n,
        sceneIdCrc: TATOOINE_SCENE_CRC,
      },
      targetAppearance: 0xabcd_ef01,
      description: { table: 'mission/m0001', textIndex: 0, text: 'description' },
      title: { table: 'mission/m0001', textIndex: 0, text: 'title' },
      status: 0,
      missionType: 1, // destroy
      targetName: 'object/mobile/womp_rat_juvenile.iff',
      waypoint: {
        appearanceNameCrc: 0,
        location: {
          coordinates: { x: -1234, y: 5, z: 4567 },
          cell: 0n,
          sceneIdCrc: TATOOINE_SCENE_CRC,
        },
        name: 'Womp Rat Hunt',
        networkId: 0x4321n,
        color: WaypointColor.Yellow,
        active: true,
      },
    };
    const bytes = buildPayload(original);
    const iter = new ReadIterator(bytes);
    const decoded = MissionObjectSharedDecoder.decode(iter);

    expect(decoded.difficulty).toBe(5);
    expect(decoded.reward).toBe(1500);
    expect(decoded.missionCreator).toBe('Tibik the Hutt');
    expect(decoded.targetName).toBe('object/mobile/womp_rat_juvenile.iff');
    expect(decoded.missionType).toBe(1);
    expect(decoded.targetAppearance).toBe(0xabcd_ef01);
    expect(decoded.description.table).toBe('mission/m0001');
    expect(decoded.title.text).toBe('title');
    expect(decoded.endLocation.sceneIdCrc).toBe(TATOOINE_SCENE_CRC);
    expect(decoded.endLocation.coordinates.x).toBeCloseTo(-1234, 4);
    expect(decoded.endLocation.coordinates.z).toBeCloseTo(4567, 4);
    expect(decoded.waypoint.name).toBe('Womp Rat Hunt');
    expect(decoded.waypoint.color).toBe(WaypointColor.Yellow);
    expect(decoded.waypoint.active).toBe(true);
    expect(decoded.waypoint.networkId).toBe(0x4321n);
  });

  it('handles an empty / freshly-spawned MissionObject', () => {
    const original: MissionObjectSharedBaseline = {
      complexity: 0,
      nameStringId: { table: '', textIndex: 0, text: '' },
      objectName: '',
      volume: 0,
      count: 0,
      difficulty: 0,
      endLocation: { coordinates: { x: 0, y: 0, z: 0 }, cell: 0n, sceneIdCrc: 0 },
      missionCreator: '',
      reward: 0,
      startLocation: { coordinates: { x: 0, y: 0, z: 0 }, cell: 0n, sceneIdCrc: 0 },
      targetAppearance: 0,
      description: { table: '', textIndex: 0, text: '' },
      title: { table: '', textIndex: 0, text: '' },
      status: 0,
      missionType: 0,
      targetName: '',
      waypoint: {
        appearanceNameCrc: 0,
        location: { coordinates: { x: 0, y: 0, z: 0 }, cell: 0n, sceneIdCrc: 0 },
        name: '',
        networkId: 0n,
        color: WaypointColor.Invisible,
        active: false,
      },
    };
    const bytes = buildPayload(original);
    const iter = new ReadIterator(bytes);
    const decoded = MissionObjectSharedDecoder.decode(iter);
    expect(decoded.difficulty).toBe(0);
    expect(decoded.reward).toBe(0);
    expect(decoded.targetName).toBe('');
    expect(decoded.waypoint.active).toBe(false);
  });

  it('rejects a payload with the wrong memberCount prefix', () => {
    const s = new ByteStream();
    // Claim 18 members instead of 17
    writeMemberCount(s, 18);
    expect(() => MissionObjectSharedDecoder.decode(new ReadIterator(s.toBytes()))).toThrow(
      /memberCount mismatch/,
    );
  });

  it('handles a bounty-mission with non-trivial waypoint NetworkId', () => {
    const original: MissionObjectSharedBaseline = {
      complexity: 0,
      nameStringId: { table: '', textIndex: 0, text: '' },
      objectName: 'Bounty: Han Solo',
      volume: 1,
      count: 0,
      difficulty: 10,
      endLocation: {
        coordinates: { x: 100, y: 0, z: 200 },
        cell: 0n,
        sceneIdCrc: TATOOINE_SCENE_CRC,
      },
      missionCreator: 'Boba Fett',
      reward: 50_000,
      startLocation: {
        coordinates: { x: 0, y: 0, z: 0 },
        cell: 0n,
        sceneIdCrc: TATOOINE_SCENE_CRC,
      },
      targetAppearance: 0,
      description: { table: 'mission/bounty', textIndex: 0, text: 'm0042_d' },
      title: { table: 'mission/bounty', textIndex: 0, text: 'm0042_t' },
      status: 0,
      missionType: 6, // bounty
      targetName: 'object/mobile/dressed_han.iff',
      waypoint: {
        appearanceNameCrc: 0xc0de_face,
        location: {
          coordinates: { x: 100, y: 0, z: 200 },
          cell: 0n,
          sceneIdCrc: TATOOINE_SCENE_CRC,
        },
        name: 'Han Solo Bounty',
        networkId: 0x0102_0304_0506_0708n,
        color: WaypointColor.Purple,
        active: true,
      },
    };
    const bytes = buildPayload(original);
    const iter = new ReadIterator(bytes);
    const decoded = MissionObjectSharedDecoder.decode(iter);
    expect(decoded.reward).toBe(50_000);
    expect(decoded.missionType).toBe(6);
    expect(decoded.waypoint.networkId).toBe(0x0102_0304_0506_0708n);
    expect(decoded.waypoint.appearanceNameCrc).toBe(0xc0de_face);
    expect(decoded.objectName).toBe('Bounty: Han Solo');
  });
});
