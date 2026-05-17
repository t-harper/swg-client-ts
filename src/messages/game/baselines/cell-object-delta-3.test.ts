import { describe, expect, it } from 'vitest';

import { ByteStream } from '../../../archive/byte-stream.js';
import { ReadIterator } from '../../../archive/read-iterator.js';
import { writeStdString } from '../../../archive/string.js';
import { writeUnicodeString } from '../../../archive/unicode-string.js';
import type { CellObjectSharedBaseline } from './cell-object-baseline-3.js';
import { tryDecodeDelta } from './delta-registry.js';
import { BaselinePackageIds, ObjectTypeTags } from './registry.js';

// Side-effect: ensure the SCLT/SHARED delta decoder is registered.
import './cell-object-delta-3.js';

const TYPE_ID = ObjectTypeTags.SCLT;
const PACKAGE_ID = BaselinePackageIds.SHARED;

function decode(payload: Uint8Array) {
  return tryDecodeDelta(TYPE_ID, PACKAGE_ID, payload, (b) => new ReadIterator(b));
}

describe('CellObjectSharedDelta', () => {
  it('decodes a single-field delta (isPublic only)', () => {
    const inner = new ByteStream();
    inner.writeU16(1); // count
    inner.writeU16(4); // fieldIndex 4 = isPublic
    inner.writeU8(1); // true

    const result = decode(inner.toBytes());
    expect(result).not.toBeNull();
    expect(result?.kind).toBe('CellObjectSharedDelta');

    const data = result?.data as Partial<CellObjectSharedBaseline>;
    expect(data.isPublic).toBe(true);
    // Other fields must be absent (sparse delta).
    expect('complexity' in data).toBe(false);
    expect('nameStringId' in data).toBe(false);
    expect('objectName' in data).toBe(false);
    expect('volume' in data).toBe(false);
    expect('cellNumber' in data).toBe(false);
    expect(Object.keys(data)).toEqual(['isPublic']);
  });

  it('decodes a multi-field delta (cellNumber + isPublic)', () => {
    const inner = new ByteStream();
    inner.writeU16(2);
    // fieldIndex 5 = cellNumber
    inner.writeU16(5);
    inner.writeI32(7);
    // fieldIndex 4 = isPublic
    inner.writeU16(4);
    inner.writeU8(0); // false

    const result = decode(inner.toBytes());
    expect(result).not.toBeNull();
    const data = result?.data as Partial<CellObjectSharedBaseline>;
    expect(data.cellNumber).toBe(7);
    expect(data.isPublic).toBe(false);
    expect('complexity' in data).toBe(false);
    expect('nameStringId' in data).toBe(false);
    expect('objectName' in data).toBe(false);
    expect('volume' in data).toBe(false);
  });

  it('decodes a ServerObject-section delta touching all 4 inherited fields', () => {
    const inner = new ByteStream();
    inner.writeU16(4);
    // fieldIndex 0 = complexity (f32)
    inner.writeU16(0);
    inner.writeF32(1.5);
    // fieldIndex 1 = nameStringId (StringId triple)
    inner.writeU16(1);
    writeStdString(inner, 'cell_n');
    inner.writeU32(0);
    writeStdString(inner, 'cantina_room_1');
    // fieldIndex 2 = objectName (Unicode::String)
    inner.writeU16(2);
    writeUnicodeString(inner, 'Cantina Backroom');
    // fieldIndex 3 = volume (i32)
    inner.writeU16(3);
    inner.writeI32(0);

    const result = decode(inner.toBytes());
    expect(result).not.toBeNull();
    const data = result?.data as Partial<CellObjectSharedBaseline>;
    expect(data.complexity).toBeCloseTo(1.5);
    expect(data.nameStringId).toEqual({
      table: 'cell_n',
      textIndex: 0,
      text: 'cantina_room_1',
    });
    expect(data.objectName).toBe('Cantina Backroom');
    expect(data.volume).toBe(0);
    // CellObject-section fields must be absent.
    expect('isPublic' in data).toBe(false);
    expect('cellNumber' in data).toBe(false);
  });

  it('returns null on out-of-range fieldIndex (swallows throw)', () => {
    const inner = new ByteStream();
    inner.writeU16(1);
    inner.writeU16(99); // package only has 6 fields (0-5)
    inner.writeI32(0);

    const result = decode(inner.toBytes());
    expect(result).toBeNull();
  });
});
