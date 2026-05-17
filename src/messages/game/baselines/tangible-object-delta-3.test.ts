import { describe, expect, it } from 'vitest';

import { ByteStream } from '../../../archive/byte-stream.js';
import { ReadIterator } from '../../../archive/read-iterator.js';
import { writeUnicodeString } from '../../../archive/unicode-string.js';
import { AutoDeltaSetCommand, type AutoDeltaSetDelta } from './auto-delta-delta-codecs.js';
import { tryDecodeDelta } from './delta-registry.js';
import { BaselinePackageIds, ObjectTypeTags } from './registry.js';
import type { TangibleObjectSharedBaseline } from './tangible-object-baseline-3.js';

// Side-effect: ensure the TANO/SHARED delta decoder is registered.
import './tangible-object-delta-3.js';

const TYPE_ID = ObjectTypeTags.TANO;
const PACKAGE_ID = BaselinePackageIds.SHARED;

function decode(payload: Uint8Array) {
  return tryDecodeDelta(TYPE_ID, PACKAGE_ID, payload, (b) => new ReadIterator(b));
}

describe('TangibleObjectSharedDelta', () => {
  it('decodes a single-field delta on complexity (f32, fieldIndex 0)', () => {
    const inner = new ByteStream();
    inner.writeU16(1); // count
    inner.writeU16(0); // fieldIndex 0 = complexity
    inner.writeF32(42.5);

    const result = decode(inner.toBytes());
    expect(result).not.toBeNull();
    expect(result?.kind).toBe('TangibleObjectSharedDelta');

    const data = result?.data as Partial<TangibleObjectSharedBaseline>;
    expect(data.complexity).toBe(42.5);
    expect(Object.keys(data)).toEqual(['complexity']);
  });

  it('decodes a single-field delta on objectName (Unicode::String, fieldIndex 2)', () => {
    const inner = new ByteStream();
    inner.writeU16(1);
    inner.writeU16(2); // fieldIndex 2 = objectName
    writeUnicodeString(inner, 'TsTestCharacter');

    const result = decode(inner.toBytes());
    expect(result).not.toBeNull();
    const data = result?.data as Partial<TangibleObjectSharedBaseline>;
    expect(data.objectName).toBe('TsTestCharacter');
    expect(Object.keys(data)).toEqual(['objectName']);
  });

  it('decodes a multi-field delta (condition + count + visible)', () => {
    const inner = new ByteStream();
    inner.writeU16(3);
    // fieldIndex 8 = condition
    inner.writeU16(8);
    inner.writeI32(0x0040); // C_crafted bit
    // fieldIndex 9 = count
    inner.writeU16(9);
    inner.writeI32(42);
    // fieldIndex 12 = visible
    inner.writeU16(12);
    inner.writeBool(true);

    const result = decode(inner.toBytes());
    expect(result).not.toBeNull();
    const data = result?.data as Partial<TangibleObjectSharedBaseline>;
    expect(data.condition).toBe(0x0040);
    expect(data.count).toBe(42);
    expect(data.visible).toBe(true);
    expect('complexity' in data).toBe(false);
    expect('objectName' in data).toBe(false);
  });

  it('decodes an AutoDeltaSet<i32> INSERT on components (fieldIndex 7)', () => {
    const inner = new ByteStream();
    inner.writeU16(1);
    inner.writeU16(7); // fieldIndex 7 = components
    // AutoDeltaSet packDelta: [u32 commandCount][u32 baselineCommandCount] then commands
    inner.writeU32(1); // commandCount
    inner.writeU32(0); // baselineCommandCount
    inner.writeU8(AutoDeltaSetCommand.INSERT);
    inner.writeI32(12345); // component table id

    const result = decode(inner.toBytes());
    expect(result).not.toBeNull();
    const data = result?.data as Partial<TangibleObjectSharedBaseline> & {
      components?: AutoDeltaSetDelta<number>[];
    };
    expect(data.components).toEqual([{ kind: 'insert', value: 12345 }]);
  });

  it('returns null on out-of-range fieldIndex (swallows throw)', () => {
    const inner = new ByteStream();
    inner.writeU16(1);
    inner.writeU16(99); // package only has 13 fields (0-12)
    inner.writeI32(0);

    const result = decode(inner.toBytes());
    expect(result).toBeNull();
  });
});
