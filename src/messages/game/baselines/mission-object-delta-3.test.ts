import { describe, expect, it } from 'vitest';

import { ByteStream } from '../../../archive/byte-stream.js';
import { ReadIterator } from '../../../archive/read-iterator.js';
import { writeStdString } from '../../../archive/string.js';
import { writeUnicodeString } from '../../../archive/unicode-string.js';
import { deltaRegistry, tryDecodeDelta } from './delta-registry.js';
import {
  LocationCodec,
  type LocationValue,
  WaypointCodec,
  WaypointColor,
  type WaypointValue,
} from './location.js';
import type { MissionObjectSharedBaseline } from './mission-object-baseline-3.js';
import {
  MissionObjectSharedDeltaDecoder,
  MissionObjectSharedDeltaKind,
} from './mission-object-delta-3.js';
import { BaselinePackageIds, ObjectTypeTags } from './registry.js';
import { StringIdCodec, type StringIdValue } from './string-id.js';

// Side-effect: ensure the MISO/SHARED delta decoder is registered.
import './mission-object-delta-3.js';

const TYPE_ID = ObjectTypeTags.MISO;
const PACKAGE_ID = BaselinePackageIds.SHARED;

function decode(payload: Uint8Array) {
  return tryDecodeDelta(TYPE_ID, PACKAGE_ID, payload, (b) => new ReadIterator(b));
}

describe('MissionObjectSharedDelta', () => {
  it('is registered for (MISO, SHARED=3) with 17 ordered fields', () => {
    expect(MissionObjectSharedDeltaDecoder.typeId).toBe(ObjectTypeTags.MISO);
    expect(MissionObjectSharedDeltaDecoder.packageId).toBe(BaselinePackageIds.SHARED);
    expect(MissionObjectSharedDeltaDecoder.kind).toBe(MissionObjectSharedDeltaKind);
    expect(MissionObjectSharedDeltaDecoder.fields.length).toBe(17);

    // Field-name ordering must match the baseline's decode() read order.
    const names = MissionObjectSharedDeltaDecoder.fields.map((f) => f.name);
    expect(names).toEqual([
      'complexity',
      'nameStringId',
      'objectName',
      'volume',
      'count',
      'difficulty',
      'endLocation',
      'missionCreator',
      'reward',
      'startLocation',
      'targetAppearance',
      'description',
      'title',
      'status',
      'missionType',
      'targetName',
      'waypoint',
    ]);

    // Lookup-by-key wiring matches the exported decoder instance.
    const found = deltaRegistry.get(TYPE_ID, PACKAGE_ID);
    expect(found).toBe(MissionObjectSharedDeltaDecoder);
  });

  it('decodes a single-field delta (status only at index 13)', () => {
    const inner = new ByteStream();
    inner.writeU16(1); // count
    inner.writeU16(13); // fieldIndex 13 = status
    inner.writeI32(2); // e.g. mission completed

    const result = decode(inner.toBytes());
    expect(result).not.toBeNull();
    expect(result?.kind).toBe(MissionObjectSharedDeltaKind);

    const data = result?.data as Partial<MissionObjectSharedBaseline>;
    expect(data.status).toBe(2);
    // No other fields should be present.
    expect(Object.keys(data)).toEqual(['status']);
  });

  it('decodes a multi-field delta (reward + missionType + targetName)', () => {
    const inner = new ByteStream();
    inner.writeU16(3);
    // fieldIndex 8 = reward (i32)
    inner.writeU16(8);
    inner.writeI32(5_000);
    // fieldIndex 14 = missionType (u32)
    inner.writeU16(14);
    inner.writeU32(0xdeadbeef);
    // fieldIndex 15 = targetName (std::string)
    inner.writeU16(15);
    writeStdString(inner, 'object/mobile/swoop_gang_thug.iff');

    const result = decode(inner.toBytes());
    expect(result).not.toBeNull();
    const data = result?.data as Partial<MissionObjectSharedBaseline>;
    expect(data.reward).toBe(5_000);
    expect(data.missionType).toBe(0xdeadbeef);
    expect(data.targetName).toBe('object/mobile/swoop_gang_thug.iff');
    // Absent fields are not present in the sparse data object.
    expect('status' in data).toBe(false);
    expect('difficulty' in data).toBe(false);
  });

  it('decodes non-primitive codec fields (StringId title + Location endLocation + Waypoint)', () => {
    const titleValue: StringIdValue = {
      table: 'mission/mission_destroy_neutral_easy',
      textIndex: 0,
      text: 'm1t',
    };
    const endLocationValue: LocationValue = {
      coordinates: { x: 1024.5, y: 5, z: -3072.25 },
      cell: 0n,
      sceneIdCrc: 0x10adbeef,
    };
    const waypointValue: WaypointValue = {
      appearanceNameCrc: 0x4321cafe,
      location: {
        coordinates: { x: 100, y: 0, z: -200 },
        cell: 0n,
        sceneIdCrc: 0xfeedface,
      },
      name: 'Destroy mission',
      networkId: 0x12345678_9abcdef0n,
      color: WaypointColor.Orange,
      active: true,
    };

    const inner = new ByteStream();
    inner.writeU16(3);
    // fieldIndex 12 = title (StringId)
    inner.writeU16(12);
    StringIdCodec.encode(inner, titleValue);
    // fieldIndex 6 = endLocation (Location)
    inner.writeU16(6);
    LocationCodec.encode(inner, endLocationValue);
    // fieldIndex 16 = waypoint (Waypoint)
    inner.writeU16(16);
    WaypointCodec.encode(inner, waypointValue);

    const result = decode(inner.toBytes());
    expect(result).not.toBeNull();
    const data = result?.data as Partial<MissionObjectSharedBaseline>;

    expect(data.title).toEqual(titleValue);
    expect(data.endLocation).toEqual(endLocationValue);
    expect(data.waypoint).toEqual(waypointValue);
    // The unicode missionCreator field should NOT be present.
    expect('missionCreator' in data).toBe(false);
  });

  it('decodes Unicode::String fields (objectName + missionCreator)', () => {
    const inner = new ByteStream();
    inner.writeU16(2);
    // fieldIndex 2 = objectName (Unicode::String)
    inner.writeU16(2);
    writeUnicodeString(inner, 'Bounty: Jabba the Hutt');
    // fieldIndex 7 = missionCreator (Unicode::String)
    inner.writeU16(7);
    writeUnicodeString(inner, 'Imperial Recruiter');

    const result = decode(inner.toBytes());
    expect(result).not.toBeNull();
    const data = result?.data as Partial<MissionObjectSharedBaseline>;
    expect(data.objectName).toBe('Bounty: Jabba the Hutt');
    expect(data.missionCreator).toBe('Imperial Recruiter');
  });

  it('returns null on out-of-range fieldIndex (swallows throw)', () => {
    const inner = new ByteStream();
    inner.writeU16(1);
    inner.writeU16(99); // package only has 17 fields (0-16)
    inner.writeI32(0);

    const result = decode(inner.toBytes());
    expect(result).toBeNull();
  });
});
