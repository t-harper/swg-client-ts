import { describe, expect, it } from 'vitest';

import { ByteStream } from '../../../archive/byte-stream.js';
import { NetworkIdCodec } from '../../../archive/network-id.js';
import { ReadIterator } from '../../../archive/read-iterator.js';
import { writeStdString } from '../../../archive/string.js';
import { writeUnicodeString } from '../../../archive/unicode-string.js';
import { writeMemberCount } from './auto-byte-stream.js';
import { BaselinePackageIds, ObjectTypeTags, baselineRegistry } from './registry.js';
import {
  type ResourceContainerObjectSharedBaseline,
  ResourceContainerObjectSharedDecoder,
  ResourceContainerObjectSharedKind,
} from './resource-container-object-baseline-3.js';
import { StringIdCodec } from './string-id.js';

import './index.js'; // side-effect registration

/** Build a synthetic RCNO baseline 3 payload byte-by-byte for round-trip testing. */
function buildPayload(data: ResourceContainerObjectSharedBaseline): Uint8Array {
  const s = new ByteStream();
  writeMemberCount(s, 15);
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
  // ResourceContainerObject section
  s.writeI32(data.quantity);
  NetworkIdCodec.encode(s, data.resourceType);
  return s.toBytes();
}

describe('ResourceContainerObjectSharedDecoder', () => {
  it('is registered for (RCNO, SHARED=3)', () => {
    expect(ResourceContainerObjectSharedDecoder.typeId).toBe(ObjectTypeTags.RCNO);
    expect(ResourceContainerObjectSharedDecoder.packageId).toBe(BaselinePackageIds.SHARED);
    expect(ResourceContainerObjectSharedDecoder.kind).toBe('ResourceContainerObjectShared');
    expect(ResourceContainerObjectSharedDecoder.expectedMemberCount).toBe(15);
  });

  it('RCNO tag matches TAG(R,C,N,O) big-endian packing', () => {
    // TAG(R,C,N,O) = ('R'<<24 | 'C'<<16 | 'N'<<8 | 'O') = 0x52434E4F
    expect(ObjectTypeTags.RCNO).toBe(0x52434e4f);
  });

  it('round-trips a minimal empty crate', () => {
    const original: ResourceContainerObjectSharedBaseline = {
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
      quantity: 0,
      resourceType: 0n,
    };
    const bytes = buildPayload(original);
    const iter = new ReadIterator(bytes);
    const decoded = ResourceContainerObjectSharedDecoder.decode(iter);
    expect(decoded).toEqual(original);
  });

  it('round-trips a realistic crate (1000 units of iron)', () => {
    const original: ResourceContainerObjectSharedBaseline = {
      complexity: 1,
      nameStringId: { table: 'resource_n', textIndex: 0, text: 'iron' },
      objectName: '',
      volume: 1,
      pvpFaction: 0,
      pvpType: 0,
      appearanceData: '',
      components: [],
      condition: 0,
      count: 0,
      damageTaken: 0,
      maxHitPoints: 1,
      visible: true,
      quantity: 1000,
      resourceType: 0x123456789abcn,
    };
    const bytes = buildPayload(original);
    const iter = new ReadIterator(bytes);
    const decoded = ResourceContainerObjectSharedDecoder.decode(iter);
    expect(decoded.quantity).toBe(1000);
    expect(decoded.resourceType).toBe(0x123456789abcn);
    expect(decoded.visible).toBe(true);
    expect(decoded.nameStringId).toEqual(original.nameStringId);
    expect(decoded.maxHitPoints).toBe(1);
  });

  it('round-trips a signed-NetworkId resourceType (high bit set)', () => {
    const negativeId = -123n;
    const original: ResourceContainerObjectSharedBaseline = {
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
      quantity: 42,
      resourceType: negativeId,
    };
    const bytes = buildPayload(original);
    const iter = new ReadIterator(bytes);
    const decoded = ResourceContainerObjectSharedDecoder.decode(iter);
    expect(decoded.resourceType).toBe(negativeId);
  });

  it('throws on wrong memberCount prefix', () => {
    const s = new ByteStream();
    writeMemberCount(s, 14); // wrong! should be 15
    const bytes = s.toBytes();
    const iter = new ReadIterator(bytes);
    expect(() => ResourceContainerObjectSharedDecoder.decode(iter)).toThrow(/memberCount/);
  });

  it('found via baselineRegistry.get(RCNO, SHARED)', () => {
    const d = baselineRegistry.get(ObjectTypeTags.RCNO, BaselinePackageIds.SHARED);
    expect(d).toBe(ResourceContainerObjectSharedDecoder);
    expect(d?.kind).toBe(ResourceContainerObjectSharedKind);
  });
});
