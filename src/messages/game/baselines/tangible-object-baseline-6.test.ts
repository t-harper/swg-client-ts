import { describe, expect, it } from 'vitest';

import { ByteStream } from '../../../archive/byte-stream.js';
import { NetworkIdCodec } from '../../../archive/network-id.js';
import { ReadIterator } from '../../../archive/read-iterator.js';
import { writeStdString } from '../../../archive/string.js';
import { writeMemberCount } from './auto-byte-stream.js';
import { BaselinePackageIds, ObjectTypeTags, baselineRegistry } from './registry.js';
import { StringIdCodec } from './string-id.js';
import {
  type TangibleObjectEffect,
  type TangibleObjectSharedNpBaseline,
  TangibleObjectSharedNpDecoder,
} from './tangible-object-baseline-6.js';

import './index.js';

function writeEffect(s: ByteStream, e: TangibleObjectEffect): void {
  // Map cmd: ADD = 0
  s.writeU8(0);
  // Key: std::string (the effect name)
  writeStdString(s, e.name);
  // Value: pair<string, pair<string, pair<Vector, float>>>
  writeStdString(s, e.effectScript);
  writeStdString(s, e.hardpoint);
  s.writeF32(e.offset.x);
  s.writeF32(e.offset.y);
  s.writeF32(e.offset.z);
  s.writeF32(e.scale);
}

function buildPayload(data: TangibleObjectSharedNpBaseline): Uint8Array {
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

describe('TangibleObjectSharedNpDecoder', () => {
  it('is registered for (TANO, SHARED_NP=6)', () => {
    expect(TangibleObjectSharedNpDecoder.typeId).toBe(ObjectTypeTags.TANO);
    expect(TangibleObjectSharedNpDecoder.packageId).toBe(BaselinePackageIds.SHARED_NP);
    expect(TangibleObjectSharedNpDecoder.expectedMemberCount).toBe(8);
  });

  it('round-trips a default-state payload', () => {
    const original: TangibleObjectSharedNpBaseline = {
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
    const decoded = TangibleObjectSharedNpDecoder.decode(iter);
    expect(decoded).toEqual(original);
  });

  it('round-trips with non-empty sets and effects', () => {
    const original: TangibleObjectSharedNpBaseline = {
      authServerProcessId: 100,
      descriptionStringId: { table: 'obj_d', textIndex: 0, text: 'fancy_armor' },
      inCombat: true,
      passiveRevealPlayerCharacter: [0x111n, 0x222n],
      mapColorOverride: 0xff00ff,
      accessList: [0x1000n, 0x2000n],
      guildAccessList: [42, 99],
      effects: [
        {
          name: 'glow_red',
          effectScript: 'effect/red_aura.efc',
          hardpoint: 'hp_left_hand',
          offset: { x: 0, y: 1.5, z: 0 },
          scale: 1,
        },
        {
          name: 'spark',
          effectScript: 'effect/spark.efc',
          hardpoint: '',
          offset: { x: -0.5, y: 0, z: 2 },
          scale: 0.5,
        },
      ],
    };
    const bytes = buildPayload(original);
    const iter = new ReadIterator(bytes);
    const decoded = TangibleObjectSharedNpDecoder.decode(iter);
    expect(decoded.authServerProcessId).toBe(100);
    expect(decoded.inCombat).toBe(true);
    expect(decoded.passiveRevealPlayerCharacter).toEqual([0x111n, 0x222n]);
    expect(decoded.mapColorOverride).toBe(0xff00ff);
    expect(decoded.accessList).toEqual([0x1000n, 0x2000n]);
    expect(decoded.guildAccessList).toEqual([42, 99]);
    expect(decoded.effects.length).toBe(2);
    expect(decoded.effects[0]?.name).toBe('glow_red');
    expect(decoded.effects[0]?.effectScript).toBe('effect/red_aura.efc');
    expect(decoded.effects[0]?.hardpoint).toBe('hp_left_hand');
    expect(decoded.effects[0]?.offset).toEqual({ x: 0, y: 1.5, z: 0 });
    expect(decoded.effects[1]?.name).toBe('spark');
    expect(decoded.effects[1]?.scale).toBeCloseTo(0.5, 5);
  });

  it('found via baselineRegistry.get(TANO, SHARED_NP)', () => {
    const d = baselineRegistry.get(ObjectTypeTags.TANO, BaselinePackageIds.SHARED_NP);
    expect(d).toBe(TangibleObjectSharedNpDecoder);
  });
});
