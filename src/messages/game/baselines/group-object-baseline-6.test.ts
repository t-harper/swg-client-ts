import { describe, expect, it } from 'vitest';

import { ByteStream } from '../../../archive/byte-stream.js';
import { NetworkIdCodec } from '../../../archive/network-id.js';
import { ReadIterator } from '../../../archive/read-iterator.js';
import { writeStdString } from '../../../archive/string.js';
import { Vector3Codec } from '../../../archive/transform.js';
import { writeMemberCount } from './auto-byte-stream.js';
import {
  type GroupObjectSharedNpBaseline,
  GroupObjectSharedNpDecoder,
  GroupObjectSharedNpKind,
} from './group-object-baseline-6.js';
import { BaselinePackageIds, ObjectTypeTags, baselineRegistry } from './registry.js';
import { StringIdCodec } from './string-id.js';

import './index.js';

function buildPayload(data: GroupObjectSharedNpBaseline): Uint8Array {
  const s = new ByteStream();
  writeMemberCount(s, 11);
  // ServerObject SHARED_NP
  s.writeU32(data.authServerProcessId);
  StringIdCodec.encode(s, data.descriptionStringId);
  // m_groupMembers (AutoDeltaVector<pair<NetworkId, std::string>>)
  s.writeU32(data.members.length);
  s.writeU32(0); // baselineCommandCount
  for (const m of data.members) {
    NetworkIdCodec.encode(s, m.id);
    writeStdString(s, m.name);
  }
  // m_groupShipFormationMembers
  s.writeU32(data.shipFormationMembers.length);
  s.writeU32(0);
  for (const f of data.shipFormationMembers) {
    NetworkIdCodec.encode(s, f.shipId);
    s.writeI32(f.formationSlot);
  }
  writeStdString(s, data.groupName);
  s.writeI16(data.groupLevel);
  s.writeU32(data.formationNameCrc);
  NetworkIdCodec.encode(s, data.lootMaster);
  s.writeU32(data.lootRule);
  s.writeI32(data.pickupTimer.startTime);
  s.writeI32(data.pickupTimer.endTime);
  writeStdString(s, data.pickupLocation.planetName);
  Vector3Codec.encode(s, data.pickupLocation.position);
  return s.toBytes();
}

describe('GroupObjectSharedNpDecoder', () => {
  it('is registered for (GRUP, SHARED_NP=6)', () => {
    expect(GroupObjectSharedNpDecoder.typeId).toBe(ObjectTypeTags.GRUP);
    expect(GroupObjectSharedNpDecoder.packageId).toBe(BaselinePackageIds.SHARED_NP);
    expect(GroupObjectSharedNpDecoder.kind).toBe(GroupObjectSharedNpKind);
    expect(GroupObjectSharedNpDecoder.expectedMemberCount).toBe(11);
  });

  it('is found via baselineRegistry.get(GRUP, SHARED_NP)', () => {
    const d = baselineRegistry.get(ObjectTypeTags.GRUP, BaselinePackageIds.SHARED_NP);
    expect(d).toBe(GroupObjectSharedNpDecoder);
  });

  it('round-trips a 3-member group', () => {
    const original: GroupObjectSharedNpBaseline = {
      authServerProcessId: 0x1234_5678,
      descriptionStringId: { table: '', textIndex: 0, text: '' },
      members: [
        { id: 0xaaa1n, name: 'Leader' },
        { id: 0xaaa2n, name: 'Bob' },
        { id: 0xaaa3n, name: 'Carol' },
      ],
      shipFormationMembers: [],
      groupName: '',
      groupLevel: 12,
      formationNameCrc: 0,
      lootMaster: 0xaaa1n,
      lootRule: 0,
      pickupTimer: { startTime: 0, endTime: 0 },
      pickupLocation: { planetName: '', position: { x: 0, y: 0, z: 0 } },
    };
    const bytes = buildPayload(original);
    const decoded = GroupObjectSharedNpDecoder.decode(new ReadIterator(bytes));
    expect(decoded.members).toEqual(original.members);
    expect(decoded.groupLevel).toBe(12);
    expect(decoded.lootMaster).toBe(0xaaa1n);
    expect(decoded.shipFormationMembers).toEqual([]);
    expect(decoded.pickupLocation.planetName).toBe('');
  });

  it('round-trips a group with a non-trivial pickup location + non-empty formation', () => {
    const original: GroupObjectSharedNpBaseline = {
      authServerProcessId: 7,
      descriptionStringId: { table: '', textIndex: 0, text: '' },
      members: [
        { id: 0xb0001n, name: 'Captain' },
        { id: 0xb0002n, name: 'Wingman' },
      ],
      shipFormationMembers: [
        { shipId: 0xc0001n, formationSlot: 0 },
        { shipId: 0xc0002n, formationSlot: 1 },
      ],
      groupName: 'Strike Squadron',
      groupLevel: 90,
      formationNameCrc: 0xdeadbeef,
      lootMaster: 0xb0001n,
      lootRule: 2,
      pickupTimer: { startTime: 1_700_000_000, endTime: 1_700_003_600 },
      pickupLocation: { planetName: 'naboo', position: { x: -4800, y: 5, z: 4100 } },
    };
    const bytes = buildPayload(original);
    const decoded = GroupObjectSharedNpDecoder.decode(new ReadIterator(bytes));
    expect(decoded.shipFormationMembers).toEqual(original.shipFormationMembers);
    expect(decoded.formationNameCrc).toBe(0xdeadbeef);
    expect(decoded.pickupTimer.endTime).toBe(1_700_003_600);
    expect(decoded.pickupLocation.position.x).toBeCloseTo(-4800, 4);
    expect(decoded.pickupLocation.planetName).toBe('naboo');
    expect(decoded.groupName).toBe('Strike Squadron');
  });

  it('rejects a payload with the wrong memberCount prefix', () => {
    const s = new ByteStream();
    writeMemberCount(s, 9);
    expect(() => GroupObjectSharedNpDecoder.decode(new ReadIterator(s.toBytes()))).toThrow(
      /memberCount mismatch/,
    );
  });
});
