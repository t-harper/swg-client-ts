import { describe, expect, it } from 'vitest';

import { ByteStream } from '../../../archive/byte-stream.js';
import { ReadIterator } from '../../../archive/read-iterator.js';
import { Vector3Codec } from '../../../archive/transform.js';
import { writeUnicodeString } from '../../../archive/unicode-string.js';
import type { CellObjectSharedNpBaseline } from './cell-object-baseline-6.js';
import {
  CellObjectSharedNpDeltaDecoder,
  CellObjectSharedNpDeltaKind,
} from './cell-object-delta-6.js';
import { deltaRegistry, tryDecodeDelta } from './delta-registry.js';
import { BaselinePackageIds, ObjectTypeTags } from './registry.js';
import { StringIdCodec } from './string-id.js';

// Side-effect: ensure the SCLT/SHARED_NP delta decoder is registered.
import './cell-object-delta-6.js';

const TYPE_ID = ObjectTypeTags.SCLT;
const PACKAGE_ID = BaselinePackageIds.SHARED_NP;

function decode(payload: Uint8Array) {
  return tryDecodeDelta(TYPE_ID, PACKAGE_ID, payload, (b) => new ReadIterator(b));
}

describe('CellObjectSharedNpDeltaDecoder', () => {
  it('is registered for (SCLT, SHARED_NP=6) with all 4 fields in the correct order', () => {
    expect(CellObjectSharedNpDeltaDecoder.typeId).toBe(ObjectTypeTags.SCLT);
    expect(CellObjectSharedNpDeltaDecoder.packageId).toBe(BaselinePackageIds.SHARED_NP);
    expect(CellObjectSharedNpDeltaDecoder.kind).toBe(CellObjectSharedNpDeltaKind);
    expect(CellObjectSharedNpDeltaDecoder.fields).toHaveLength(4);
    expect(CellObjectSharedNpDeltaDecoder.fields.map((f) => f.name)).toEqual([
      // ServerObject
      'authServerProcessId',
      'descriptionStringId',
      // CellObject
      'cellLabel',
      'labelLocationOffset',
    ]);
  });

  it('discoverable via deltaRegistry.get(SCLT, SHARED_NP)', () => {
    const found = deltaRegistry.get(ObjectTypeTags.SCLT, BaselinePackageIds.SHARED_NP);
    expect(found).toBe(CellObjectSharedNpDeltaDecoder);
    const byKind = deltaRegistry.getByKind(CellObjectSharedNpDeltaKind);
    expect(byKind).toBe(CellObjectSharedNpDeltaDecoder);
  });

  it('decodes a single-field delta (cellLabel rename only — player relabels a room)', () => {
    // [u16 count=1][u16 fieldIndex=2 (cellLabel)][UnicodeString "Travis's Library"]
    const inner = new ByteStream();
    inner.writeU16(1);
    inner.writeU16(2);
    writeUnicodeString(inner, "Travis's Library");

    const result = decode(inner.toBytes());
    expect(result).not.toBeNull();
    expect(result?.kind).toBe(CellObjectSharedNpDeltaKind);

    const data = result?.data as Partial<CellObjectSharedNpBaseline>;
    expect(Object.keys(data)).toEqual(['cellLabel']);
    expect(data.cellLabel).toBe("Travis's Library");
    // Other fields must be absent (sparse).
    expect('authServerProcessId' in data).toBe(false);
    expect('descriptionStringId' in data).toBe(false);
    expect('labelLocationOffset' in data).toBe(false);
  });

  it('decodes a multi-field delta (cellLabel + labelLocationOffset together)', () => {
    // On-wire field order is ascending by fieldIndex (AutoDeltaByteStream::packDeltas
    // iterates members by increasing index). cellLabel=2, labelLocationOffset=3.
    const inner = new ByteStream();
    inner.writeU16(2);
    // cellLabel (index 2)
    inner.writeU16(2);
    writeUnicodeString(inner, 'Café — Boba');
    // labelLocationOffset (index 3)
    inner.writeU16(3);
    Vector3Codec.encode(inner, { x: 0.5, y: 2.0, z: -1.25 });

    const result = decode(inner.toBytes());
    expect(result).not.toBeNull();
    expect(result?.kind).toBe(CellObjectSharedNpDeltaKind);

    const data = result?.data as Partial<CellObjectSharedNpBaseline>;
    expect(Object.keys(data).sort()).toEqual(['cellLabel', 'labelLocationOffset']);
    expect(data.cellLabel).toBe('Café — Boba');
    expect(data.labelLocationOffset?.x).toBeCloseTo(0.5, 5);
    expect(data.labelLocationOffset?.y).toBeCloseTo(2.0, 5);
    expect(data.labelLocationOffset?.z).toBeCloseTo(-1.25, 5);
  });

  it('decodes all four fields in one delta (mixed primitive + StringId + Unicode + Vector)', () => {
    // Touch every field at once — exercises every codec end-to-end and
    // confirms the field-index dispatch maps to the right reader.
    const inner = new ByteStream();
    inner.writeU16(4);
    // authServerProcessId (index 0)
    inner.writeU16(0);
    inner.writeU32(0xdead_beef);
    // descriptionStringId (index 1)
    inner.writeU16(1);
    StringIdCodec.encode(inner, { table: 'cell_d', textIndex: 7, text: 'main_room' });
    // cellLabel (index 2)
    inner.writeU16(2);
    writeUnicodeString(inner, 'Renamed Cell');
    // labelLocationOffset (index 3)
    inner.writeU16(3);
    Vector3Codec.encode(inner, { x: 1, y: 2, z: 3 });

    const result = decode(inner.toBytes());
    expect(result).not.toBeNull();
    const data = result?.data as Partial<CellObjectSharedNpBaseline>;
    expect(Object.keys(data).sort()).toEqual([
      'authServerProcessId',
      'cellLabel',
      'descriptionStringId',
      'labelLocationOffset',
    ]);
    expect(data.authServerProcessId).toBe(0xdead_beef);
    expect(data.descriptionStringId).toEqual({
      table: 'cell_d',
      textIndex: 7,
      text: 'main_room',
    });
    expect(data.cellLabel).toBe('Renamed Cell');
    expect(data.labelLocationOffset?.x).toBeCloseTo(1, 5);
    expect(data.labelLocationOffset?.y).toBeCloseTo(2, 5);
    expect(data.labelLocationOffset?.z).toBeCloseTo(3, 5);
  });

  it('returns null on out-of-range fieldIndex (swallows throw)', () => {
    // Package only has 4 fields (0..3); fieldIndex 99 must trip the
    // out-of-range guard in delta-registry's tryDecodeDelta.
    const inner = new ByteStream();
    inner.writeU16(1);
    inner.writeU16(99);
    inner.writeU32(0);

    const result = decode(inner.toBytes());
    expect(result).toBeNull();
  });
});
