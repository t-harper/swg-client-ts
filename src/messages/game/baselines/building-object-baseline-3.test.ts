import { describe, expect, it } from 'vitest';

import { ByteStream } from '../../../archive/byte-stream.js';
import { ReadIterator } from '../../../archive/read-iterator.js';
import { writeStdString } from '../../../archive/string.js';
import { writeUnicodeString } from '../../../archive/unicode-string.js';
import { writeMemberCount } from './auto-byte-stream.js';
import {
  type BuildingObjectSharedBaseline,
  BuildingObjectSharedDecoder,
  BuildingObjectSharedKind,
} from './building-object-baseline-3.js';
import { BaselinePackageIds, ObjectTypeTags, baselineRegistry } from './registry.js';
import { StringIdCodec } from './string-id.js';

import './index.js'; // side-effect registration

/** Build a synthetic BUIO baseline 3 payload byte-by-byte for round-trip testing. */
function buildPayload(data: BuildingObjectSharedBaseline): Uint8Array {
  const s = new ByteStream();
  writeMemberCount(s, 13);
  // ServerObject section
  s.writeF32(data.complexity);
  StringIdCodec.encode(s, data.nameStringId);
  writeUnicodeString(s, data.objectName);
  s.writeI32(data.volume);
  // TangibleObject section
  s.writeU32(data.pvpFaction);
  s.writeI32(data.pvpType);
  writeStdString(s, data.appearanceData);
  // AutoDeltaSet<int>: [u32 size][u32 baselineCommandCount=0][i32 values...]
  s.writeU32(data.components.length);
  s.writeU32(0);
  for (const c of data.components) s.writeI32(c);
  s.writeI32(data.condition);
  s.writeI32(data.count);
  s.writeI32(data.damageTaken);
  s.writeI32(data.maxHitPoints);
  s.writeBool(data.visible);
  return s.toBytes();
}

describe('BuildingObjectSharedDecoder', () => {
  it('is registered for (BUIO, SHARED=3)', () => {
    expect(BuildingObjectSharedDecoder.typeId).toBe(ObjectTypeTags.BUIO);
    expect(BuildingObjectSharedDecoder.packageId).toBe(BaselinePackageIds.SHARED);
    expect(BuildingObjectSharedDecoder.kind).toBe('BuildingObjectShared');
    expect(BuildingObjectSharedDecoder.expectedMemberCount).toBe(13);
  });

  it('round-trips a minimal payload', () => {
    const original: BuildingObjectSharedBaseline = {
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
      damageTaken: 0,
      maxHitPoints: 0,
      visible: false,
    };
    const bytes = buildPayload(original);
    const iter = new ReadIterator(bytes);
    const decoded = BuildingObjectSharedDecoder.decode(iter);
    expect(decoded).toEqual(original);
  });

  it('round-trips a realistic payload (a Mos Eisley cantina-like building)', () => {
    const original: BuildingObjectSharedBaseline = {
      complexity: 250.0,
      nameStringId: {
        table: 'building_name',
        textIndex: 0,
        text: 'cantina_mos_eisley',
      },
      objectName: 'Mos Eisley Cantina',
      volume: 1000,
      pvpFaction: 0,
      pvpType: 0,
      appearanceData: '',
      components: [],
      condition: 0,
      count: 0,
      damageTaken: 0,
      maxHitPoints: 50000,
      visible: true,
    };
    const bytes = buildPayload(original);
    const iter = new ReadIterator(bytes);
    const decoded = BuildingObjectSharedDecoder.decode(iter);
    expect(decoded.complexity).toBeCloseTo(250.0, 5);
    expect(decoded.nameStringId).toEqual(original.nameStringId);
    expect(decoded.objectName).toBe(original.objectName);
    expect(decoded.volume).toBe(original.volume);
    expect(decoded.pvpFaction).toBe(original.pvpFaction);
    expect(decoded.pvpType).toBe(original.pvpType);
    expect(decoded.appearanceData).toBe(original.appearanceData);
    expect(decoded.components).toEqual([]);
    expect(decoded.condition).toBe(original.condition);
    expect(decoded.count).toBe(original.count);
    expect(decoded.damageTaken).toBe(original.damageTaken);
    expect(decoded.maxHitPoints).toBe(original.maxHitPoints);
    expect(decoded.visible).toBe(original.visible);
  });

  it('throws on wrong memberCount prefix', () => {
    const s = new ByteStream();
    writeMemberCount(s, 12); // wrong! should be 13
    const bytes = s.toBytes();
    const iter = new ReadIterator(bytes);
    expect(() => BuildingObjectSharedDecoder.decode(iter)).toThrow(/memberCount/);
  });

  it('found via baselineRegistry.get(BUIO, SHARED)', () => {
    const d = baselineRegistry.get(ObjectTypeTags.BUIO, BaselinePackageIds.SHARED);
    expect(d).toBe(BuildingObjectSharedDecoder);
    expect(d?.kind).toBe(BuildingObjectSharedKind);
  });
});
