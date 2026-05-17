import { describe, expect, it } from 'vitest';

import { ByteStream } from '../../../archive/byte-stream.js';
import { ReadIterator } from '../../../archive/read-iterator.js';
import { Vector3Codec } from '../../../archive/transform.js';
import { writeUnicodeString } from '../../../archive/unicode-string.js';
import { writeMemberCount } from './auto-byte-stream.js';
import {
  type CellObjectSharedNpBaseline,
  CellObjectSharedNpDecoder,
  CellObjectSharedNpKind,
} from './cell-object-baseline-6.js';
import { BaselinePackageIds, ObjectTypeTags, baselineRegistry } from './registry.js';
import { StringIdCodec } from './string-id.js';

import './index.js'; // side-effect registration

/** Build a synthetic SCLT baseline 6 payload byte-by-byte for round-trip testing. */
function buildPayload(data: CellObjectSharedNpBaseline): Uint8Array {
  const s = new ByteStream();
  writeMemberCount(s, 4);
  // ServerObject section
  s.writeU32(data.authServerProcessId);
  StringIdCodec.encode(s, data.descriptionStringId);
  // CellObject section
  writeUnicodeString(s, data.cellLabel);
  Vector3Codec.encode(s, data.labelLocationOffset);
  return s.toBytes();
}

describe('CellObjectSharedNpDecoder', () => {
  it('is registered for (SCLT, SHARED_NP=6)', () => {
    expect(CellObjectSharedNpDecoder.typeId).toBe(ObjectTypeTags.SCLT);
    expect(CellObjectSharedNpDecoder.packageId).toBe(BaselinePackageIds.SHARED_NP);
    expect(CellObjectSharedNpDecoder.kind).toBe('CellObjectSharedNp');
    expect(CellObjectSharedNpDecoder.expectedMemberCount).toBe(4);
  });

  it('round-trips a default payload (no label, zero offset)', () => {
    const original: CellObjectSharedNpBaseline = {
      authServerProcessId: 100,
      descriptionStringId: { table: '', textIndex: 0, text: '' },
      cellLabel: '',
      labelLocationOffset: { x: 0, y: 0, z: 0 },
    };
    const bytes = buildPayload(original);
    const iter = new ReadIterator(bytes);
    const decoded = CellObjectSharedNpDecoder.decode(iter);
    expect(decoded).toEqual(original);
  });

  it('round-trips a labeled room (player house style)', () => {
    const original: CellObjectSharedNpBaseline = {
      authServerProcessId: 7,
      descriptionStringId: { table: 'cell_d', textIndex: 0, text: 'main_room' },
      cellLabel: "Travis's Library",
      labelLocationOffset: { x: 0.5, y: 2.0, z: -1.25 },
    };
    const bytes = buildPayload(original);
    const iter = new ReadIterator(bytes);
    const decoded = CellObjectSharedNpDecoder.decode(iter);
    expect(decoded.authServerProcessId).toBe(7);
    expect(decoded.descriptionStringId).toEqual(original.descriptionStringId);
    expect(decoded.cellLabel).toBe("Travis's Library");
    expect(decoded.labelLocationOffset.x).toBeCloseTo(0.5, 5);
    expect(decoded.labelLocationOffset.y).toBeCloseTo(2.0, 5);
    expect(decoded.labelLocationOffset.z).toBeCloseTo(-1.25, 5);
  });

  it('round-trips a unicode label with non-ASCII characters', () => {
    const original: CellObjectSharedNpBaseline = {
      authServerProcessId: 99,
      descriptionStringId: { table: '', textIndex: 0, text: '' },
      cellLabel: 'Café — Boba',
      labelLocationOffset: { x: 1, y: 1, z: 1 },
    };
    const bytes = buildPayload(original);
    const iter = new ReadIterator(bytes);
    const decoded = CellObjectSharedNpDecoder.decode(iter);
    expect(decoded.cellLabel).toBe('Café — Boba');
  });

  it('throws on wrong memberCount prefix', () => {
    const s = new ByteStream();
    writeMemberCount(s, 3); // wrong! should be 4
    const bytes = s.toBytes();
    const iter = new ReadIterator(bytes);
    expect(() => CellObjectSharedNpDecoder.decode(iter)).toThrow(/memberCount/);
  });

  it('found via baselineRegistry.get(SCLT, SHARED_NP)', () => {
    const d = baselineRegistry.get(ObjectTypeTags.SCLT, BaselinePackageIds.SHARED_NP);
    expect(d).toBe(CellObjectSharedNpDecoder);
    expect(d?.kind).toBe(CellObjectSharedNpKind);
  });
});
