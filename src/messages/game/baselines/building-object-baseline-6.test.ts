import { describe, expect, it } from 'vitest';

import { ByteStream } from '../../../archive/byte-stream.js';
import { NetworkIdCodec } from '../../../archive/network-id.js';
import { ReadIterator } from '../../../archive/read-iterator.js';
import { writeStdString } from '../../../archive/string.js';
import { writeMemberCount } from './auto-byte-stream.js';
import {
  type BuildingObjectEffect,
  type BuildingObjectSharedNpBaseline,
  BuildingObjectSharedNpDecoder,
  BuildingObjectSharedNpKind,
} from './building-object-baseline-6.js';
import { BaselinePackageIds, ObjectTypeTags, baselineRegistry } from './registry.js';
import { StringIdCodec } from './string-id.js';

import './index.js'; // side-effect registration

function writeEffect(s: ByteStream, e: BuildingObjectEffect): void {
  // Map cmd: ADD = 0
  s.writeU8(0);
  // Key: std::string (effect name)
  writeStdString(s, e.name);
  // Value: pair<string, pair<string, pair<Vector, float>>>
  writeStdString(s, e.effectScript);
  writeStdString(s, e.hardpoint);
  s.writeF32(e.offset.x);
  s.writeF32(e.offset.y);
  s.writeF32(e.offset.z);
  s.writeF32(e.scale);
}

/** Build a synthetic BUIO baseline 6 payload byte-by-byte for round-trip testing. */
function buildPayload(data: BuildingObjectSharedNpBaseline): Uint8Array {
  const s = new ByteStream();
  writeMemberCount(s, 8);
  // ServerObject section
  s.writeU32(data.authServerProcessId);
  StringIdCodec.encode(s, data.descriptionStringId);
  // TangibleObject section
  s.writeBool(data.inCombat);
  // AutoDeltaSet<NetworkId>: [u32 size][u32 baselineCommandCount=0][i64 values]
  s.writeU32(data.passiveRevealPlayerCharacter.length);
  s.writeU32(0);
  for (const id of data.passiveRevealPlayerCharacter) NetworkIdCodec.encode(s, id);
  s.writeU32(data.mapColorOverride);
  s.writeU32(data.accessList.length);
  s.writeU32(0);
  for (const id of data.accessList) NetworkIdCodec.encode(s, id);
  s.writeU32(data.guildAccessList.length);
  s.writeU32(0);
  for (const v of data.guildAccessList) s.writeI32(v);
  // AutoDeltaMap effects: [u32 size][u32 baselineCommandCount=0][per-entry data]
  s.writeU32(data.effects.length);
  s.writeU32(0);
  for (const e of data.effects) writeEffect(s, e);
  return s.toBytes();
}

describe('BuildingObjectSharedNpDecoder', () => {
  it('is registered for (BUIO, SHARED_NP=6)', () => {
    expect(BuildingObjectSharedNpDecoder.typeId).toBe(ObjectTypeTags.BUIO);
    expect(BuildingObjectSharedNpDecoder.packageId).toBe(BaselinePackageIds.SHARED_NP);
    expect(BuildingObjectSharedNpDecoder.kind).toBe('BuildingObjectSharedNp');
    expect(BuildingObjectSharedNpDecoder.expectedMemberCount).toBe(8);
  });

  it('round-trips a default-state payload (empty sets/lists/effects)', () => {
    const original: BuildingObjectSharedNpBaseline = {
      authServerProcessId: 100,
      descriptionStringId: { table: '', textIndex: 0, text: '' },
      inCombat: false,
      passiveRevealPlayerCharacter: [],
      mapColorOverride: 0,
      accessList: [],
      guildAccessList: [],
      effects: [],
    };
    const bytes = buildPayload(original);
    const iter = new ReadIterator(bytes);
    const decoded = BuildingObjectSharedNpDecoder.decode(iter);
    expect(decoded).toEqual(original);
  });

  it('round-trips a populated payload (player-owned house with access list)', () => {
    const original: BuildingObjectSharedNpBaseline = {
      authServerProcessId: 7,
      descriptionStringId: {
        table: 'building_d',
        textIndex: 0,
        text: 'house_small',
      },
      inCombat: false,
      passiveRevealPlayerCharacter: [],
      mapColorOverride: 0x00ff00,
      accessList: [0x1234567890n, 0x9876543210n],
      guildAccessList: [42, 99, 1337],
      effects: [
        {
          name: 'chimney_smoke',
          effectScript: 'effect/smoke_thin.efc',
          hardpoint: 'hp_chimney',
          offset: { x: 0, y: 4.5, z: 0 },
          scale: 1.0,
        },
      ],
    };
    const bytes = buildPayload(original);
    const iter = new ReadIterator(bytes);
    const decoded = BuildingObjectSharedNpDecoder.decode(iter);
    expect(decoded.authServerProcessId).toBe(7);
    expect(decoded.descriptionStringId).toEqual(original.descriptionStringId);
    expect(decoded.inCombat).toBe(false);
    expect(decoded.passiveRevealPlayerCharacter).toEqual([]);
    expect(decoded.mapColorOverride).toBe(0x00ff00);
    expect(decoded.accessList).toEqual([0x1234567890n, 0x9876543210n]);
    expect(decoded.guildAccessList).toEqual([42, 99, 1337]);
    expect(decoded.effects.length).toBe(1);
    expect(decoded.effects[0]?.name).toBe('chimney_smoke');
    expect(decoded.effects[0]?.effectScript).toBe('effect/smoke_thin.efc');
    expect(decoded.effects[0]?.hardpoint).toBe('hp_chimney');
    expect(decoded.effects[0]?.offset).toEqual({ x: 0, y: 4.5, z: 0 });
    expect(decoded.effects[0]?.scale).toBeCloseTo(1.0, 5);
  });

  it('round-trips with multiple effects and a passive-reveal list', () => {
    const original: BuildingObjectSharedNpBaseline = {
      authServerProcessId: 12,
      descriptionStringId: { table: '', textIndex: 0, text: '' },
      inCombat: true,
      passiveRevealPlayerCharacter: [0xaaaan, 0xbbbbn, 0xccccn],
      mapColorOverride: 0xff0000,
      accessList: [],
      guildAccessList: [],
      effects: [
        {
          name: 'effect_a',
          effectScript: 'effect/a.efc',
          hardpoint: '',
          offset: { x: 1, y: 2, z: 3 },
          scale: 1,
        },
        {
          name: 'effect_b',
          effectScript: 'effect/b.efc',
          hardpoint: 'hp_b',
          offset: { x: -4, y: 0, z: 0 },
          scale: 0.25,
        },
      ],
    };
    const bytes = buildPayload(original);
    const iter = new ReadIterator(bytes);
    const decoded = BuildingObjectSharedNpDecoder.decode(iter);
    expect(decoded.inCombat).toBe(true);
    expect(decoded.passiveRevealPlayerCharacter).toEqual([0xaaaan, 0xbbbbn, 0xccccn]);
    expect(decoded.effects.length).toBe(2);
    expect(decoded.effects[0]?.name).toBe('effect_a');
    expect(decoded.effects[1]?.name).toBe('effect_b');
    expect(decoded.effects[1]?.scale).toBeCloseTo(0.25, 5);
  });

  it('throws on wrong memberCount prefix', () => {
    const s = new ByteStream();
    writeMemberCount(s, 7); // wrong! should be 8
    const bytes = s.toBytes();
    const iter = new ReadIterator(bytes);
    expect(() => BuildingObjectSharedNpDecoder.decode(iter)).toThrow(/memberCount/);
  });

  it('found via baselineRegistry.get(BUIO, SHARED_NP)', () => {
    const d = baselineRegistry.get(ObjectTypeTags.BUIO, BaselinePackageIds.SHARED_NP);
    expect(d).toBe(BuildingObjectSharedNpDecoder);
    expect(d?.kind).toBe(BuildingObjectSharedNpKind);
  });
});
