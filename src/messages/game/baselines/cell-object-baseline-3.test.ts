import { describe, expect, it } from 'vitest';

import { ByteStream } from '../../../archive/byte-stream.js';
import { ReadIterator } from '../../../archive/read-iterator.js';
import { writeUnicodeString } from '../../../archive/unicode-string.js';
import { writeMemberCount } from './auto-byte-stream.js';
import {
  type CellObjectSharedBaseline,
  CellObjectSharedDecoder,
  CellObjectSharedKind,
} from './cell-object-baseline-3.js';
import { BaselinePackageIds, ObjectTypeTags, baselineRegistry } from './registry.js';
import { StringIdCodec } from './string-id.js';

import './index.js'; // side-effect registration

/** Build a synthetic SCLT baseline 3 payload byte-by-byte for round-trip testing. */
function buildPayload(data: CellObjectSharedBaseline): Uint8Array {
  const s = new ByteStream();
  writeMemberCount(s, 6);
  // ServerObject section
  s.writeF32(data.complexity);
  StringIdCodec.encode(s, data.nameStringId);
  writeUnicodeString(s, data.objectName);
  s.writeI32(data.volume);
  // CellObject section
  s.writeBool(data.isPublic);
  s.writeI32(data.cellNumber);
  return s.toBytes();
}

describe('CellObjectSharedDecoder', () => {
  it('is registered for (SCLT, SHARED=3)', () => {
    expect(CellObjectSharedDecoder.typeId).toBe(ObjectTypeTags.SCLT);
    expect(CellObjectSharedDecoder.packageId).toBe(BaselinePackageIds.SHARED);
    expect(CellObjectSharedDecoder.kind).toBe('CellObjectShared');
    expect(CellObjectSharedDecoder.expectedMemberCount).toBe(6);
  });

  it('round-trips a minimal payload (empty cell with default fields)', () => {
    const original: CellObjectSharedBaseline = {
      complexity: 0,
      nameStringId: { table: '', textIndex: 0, text: '' },
      objectName: '',
      volume: 0,
      isPublic: false,
      cellNumber: -1,
    };
    const bytes = buildPayload(original);
    const iter = new ReadIterator(bytes);
    const decoded = CellObjectSharedDecoder.decode(iter);
    expect(decoded).toEqual(original);
  });

  it('round-trips a realistic payload (a public cantina cell)', () => {
    const original: CellObjectSharedBaseline = {
      complexity: 0,
      nameStringId: {
        table: 'cell_n',
        textIndex: 0,
        text: 'main_room',
      },
      objectName: '',
      volume: 0,
      isPublic: true,
      cellNumber: 1,
    };
    const bytes = buildPayload(original);
    const iter = new ReadIterator(bytes);
    const decoded = CellObjectSharedDecoder.decode(iter);
    expect(decoded.complexity).toBeCloseTo(0, 5);
    expect(decoded.nameStringId).toEqual(original.nameStringId);
    expect(decoded.objectName).toBe(original.objectName);
    expect(decoded.volume).toBe(original.volume);
    expect(decoded.isPublic).toBe(true);
    expect(decoded.cellNumber).toBe(1);
  });

  it('round-trips with a high cellNumber and private flag', () => {
    const original: CellObjectSharedBaseline = {
      complexity: 0,
      nameStringId: { table: '', textIndex: 0, text: '' },
      objectName: '',
      volume: 0,
      isPublic: false,
      cellNumber: 42,
    };
    const bytes = buildPayload(original);
    const iter = new ReadIterator(bytes);
    const decoded = CellObjectSharedDecoder.decode(iter);
    expect(decoded.isPublic).toBe(false);
    expect(decoded.cellNumber).toBe(42);
  });

  it('throws on wrong memberCount prefix', () => {
    const s = new ByteStream();
    writeMemberCount(s, 5); // wrong! should be 6
    const bytes = s.toBytes();
    const iter = new ReadIterator(bytes);
    expect(() => CellObjectSharedDecoder.decode(iter)).toThrow(/memberCount/);
  });

  it('found via baselineRegistry.get(SCLT, SHARED)', () => {
    const d = baselineRegistry.get(ObjectTypeTags.SCLT, BaselinePackageIds.SHARED);
    expect(d).toBe(CellObjectSharedDecoder);
    expect(d?.kind).toBe(CellObjectSharedKind);
  });
});
