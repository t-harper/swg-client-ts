import { describe, expect, it } from 'vitest';

import { ByteStream } from '../../../archive/byte-stream.js';
import { ReadIterator } from '../../../archive/read-iterator.js';
import { writeStdString } from '../../../archive/string.js';
import { writeUnicodeString } from '../../../archive/unicode-string.js';
import { writeMemberCount } from './auto-byte-stream.js';
import { BaselinePackageIds, ObjectTypeTags, baselineRegistry } from './registry.js';
import { StringIdCodec } from './string-id.js';
import {
  type TangibleObjectSharedBaseline,
  TangibleObjectSharedDecoder,
  TangibleObjectSharedKind,
} from './tangible-object-baseline-3.js';

import './index.js'; // side-effect registration

/** Build a synthetic TANO baseline 3 payload byte-by-byte for round-trip testing. */
function buildPayload(data: TangibleObjectSharedBaseline): Uint8Array {
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

describe('TangibleObjectSharedDecoder', () => {
  it('is registered for (TANO, SHARED=3)', () => {
    expect(TangibleObjectSharedDecoder.typeId).toBe(ObjectTypeTags.TANO);
    expect(TangibleObjectSharedDecoder.packageId).toBe(BaselinePackageIds.SHARED);
    expect(TangibleObjectSharedDecoder.kind).toBe('TangibleObjectShared');
    expect(TangibleObjectSharedDecoder.expectedMemberCount).toBe(13);
  });

  it('round-trips a minimal payload', () => {
    const original: TangibleObjectSharedBaseline = {
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
    const decoded = TangibleObjectSharedDecoder.decode(iter);
    expect(decoded).toEqual(original);
  });

  it('round-trips a realistic payload (a vibroknuckler with a couple components)', () => {
    const original: TangibleObjectSharedBaseline = {
      complexity: 13.5,
      nameStringId: { table: 'weapon_n', textIndex: 0, text: 'vibroknuckler' },
      objectName: 'Custom Knuckler',
      volume: 1,
      pvpFaction: 0,
      pvpType: 0,
      appearanceData: '',
      components: [42, 7],
      condition: 1, // C_onOff = 0x01
      count: 1,
      damageTaken: 50,
      maxHitPoints: 1000,
      visible: true,
    };
    const bytes = buildPayload(original);
    const iter = new ReadIterator(bytes);
    const decoded = TangibleObjectSharedDecoder.decode(iter);
    // Components round-trip in sorted order per std::set semantics, but the
    // wire bytes preserve whatever order we wrote them in. Compare as a set.
    expect(decoded.complexity).toBeCloseTo(13.5, 5);
    expect(decoded.nameStringId).toEqual(original.nameStringId);
    expect(decoded.objectName).toBe(original.objectName);
    expect(decoded.volume).toBe(original.volume);
    expect(decoded.pvpFaction).toBe(original.pvpFaction);
    expect(decoded.pvpType).toBe(original.pvpType);
    expect(decoded.appearanceData).toBe(original.appearanceData);
    expect([...decoded.components].sort()).toEqual([...original.components].sort());
    expect(decoded.condition).toBe(original.condition);
    expect(decoded.count).toBe(original.count);
    expect(decoded.damageTaken).toBe(original.damageTaken);
    expect(decoded.maxHitPoints).toBe(original.maxHitPoints);
    expect(decoded.visible).toBe(original.visible);
  });

  it('throws on wrong memberCount prefix', () => {
    // Craft a payload with the wrong member count so the wire-format sanity
    // check fires.
    const s = new ByteStream();
    writeMemberCount(s, 12); // wrong! should be 13
    const bytes = s.toBytes();
    const iter = new ReadIterator(bytes);
    expect(() => TangibleObjectSharedDecoder.decode(iter)).toThrow(/memberCount/);
  });

  it('found via baselineRegistry.get(TANO, SHARED)', () => {
    const d = baselineRegistry.get(ObjectTypeTags.TANO, BaselinePackageIds.SHARED);
    expect(d).toBe(TangibleObjectSharedDecoder);
    expect(d?.kind).toBe(TangibleObjectSharedKind);
  });
});
