import { describe, expect, it } from 'vitest';

import { ByteStream } from '../../../archive/byte-stream.js';
import { ReadIterator } from '../../../archive/read-iterator.js';
import { writeStdString } from '../../../archive/string.js';
import { writeUnicodeString } from '../../../archive/unicode-string.js';
import { AutoDeltaSetCommand } from './auto-delta-delta-codecs.js';
import { deltaRegistry, tryDecodeDelta } from './delta-registry.js';
import { BaselinePackageIds, ObjectTypeTags } from './registry.js';
import {
  ResourceContainerObjectSharedDeltaDecoder,
  ResourceContainerObjectSharedDeltaKind,
} from './resource-container-object-delta-3.js';
import { StringIdCodec } from './string-id.js';

// Side-effect: ensure delta decoders are registered.
import './index.js';

describe('ResourceContainerObjectSharedDeltaDecoder', () => {
  it('is registered for (RCNO, SHARED=3) with all 15 fields in the correct order', () => {
    expect(ResourceContainerObjectSharedDeltaDecoder.typeId).toBe(ObjectTypeTags.RCNO);
    expect(ResourceContainerObjectSharedDeltaDecoder.packageId).toBe(BaselinePackageIds.SHARED);
    expect(ResourceContainerObjectSharedDeltaDecoder.kind).toBe(
      ResourceContainerObjectSharedDeltaKind,
    );
    expect(ResourceContainerObjectSharedDeltaDecoder.fields).toHaveLength(15);
    expect(ResourceContainerObjectSharedDeltaDecoder.fields.map((f) => f.name)).toEqual([
      // ServerObject
      'complexity',
      'nameStringId',
      'objectName',
      'volume',
      // TangibleObject
      'pvpFaction',
      'pvpType',
      'appearanceData',
      'components',
      'condition',
      'count',
      'damageTaken',
      'maxHitPoints',
      'visible',
      // ResourceContainerObject
      'quantity',
      'resourceType',
    ]);
  });

  it('discoverable via deltaRegistry.get(RCNO, SHARED)', () => {
    const found = deltaRegistry.get(ObjectTypeTags.RCNO, BaselinePackageIds.SHARED);
    expect(found).toBe(ResourceContainerObjectSharedDeltaDecoder);
  });

  it('decodes a single-field delta on quantity (i32) — harvester deposit tick', () => {
    // [u16 count=1][u16 fieldIndex=13 (quantity)][i32 25000]
    const inner = new ByteStream();
    inner.writeU16(1);
    inner.writeU16(13);
    inner.writeI32(25_000);

    const result = tryDecodeDelta(
      ObjectTypeTags.RCNO,
      BaselinePackageIds.SHARED,
      inner.toBytes(),
      (b) => new ReadIterator(b),
    );
    expect(result).not.toBeNull();
    expect(result?.kind).toBe(ResourceContainerObjectSharedDeltaKind);
    // Sparse: only quantity should be present.
    expect(Object.keys(result?.data ?? {})).toEqual(['quantity']);
    expect((result?.data as { quantity?: number }).quantity).toBe(25_000);
  });

  it('decodes a multi-field delta (quantity + resourceType + condition)', () => {
    // Three fields, written in ascending wire index order: 8, 13, 14.
    // The server's AutoDeltaByteStream::packDeltas iterates members by
    // increasing index, so on-wire order is ascending.
    const inner = new ByteStream();
    inner.writeU16(3);
    // condition (index 8) = 950
    inner.writeU16(8);
    inner.writeI32(950);
    // quantity (index 13) = 12345
    inner.writeU16(13);
    inner.writeI32(12_345);
    // resourceType (index 14) = 0x00000001000003e8 (some ResourceTypeObject id)
    inner.writeU16(14);
    inner.writeI64(0x0000_0001_0000_03e8n);

    const result = tryDecodeDelta(
      ObjectTypeTags.RCNO,
      BaselinePackageIds.SHARED,
      inner.toBytes(),
      (b) => new ReadIterator(b),
    );
    expect(result).not.toBeNull();
    expect(result?.kind).toBe(ResourceContainerObjectSharedDeltaKind);
    const data = result?.data as {
      condition?: number;
      quantity?: number;
      resourceType?: bigint;
    };
    expect(Object.keys(data ?? {}).sort()).toEqual(['condition', 'quantity', 'resourceType']);
    expect(data.condition).toBe(950);
    expect(data.quantity).toBe(12_345);
    expect(data.resourceType).toBe(0x0000_0001_0000_03e8n);
  });

  it('decodes a delta touching mixed primitive types (complexity, nameStringId, objectName, appearanceData, visible)', () => {
    const inner = new ByteStream();
    inner.writeU16(5);
    // complexity (index 0)
    inner.writeU16(0);
    inner.writeF32(1.5);
    // nameStringId (index 1)
    inner.writeU16(1);
    StringIdCodec.encode(inner, { table: 'resource/resource_names', textIndex: 0, text: 'iron' });
    // objectName (index 2)
    inner.writeU16(2);
    writeUnicodeString(inner, 'Heshurium');
    // appearanceData (index 6)
    inner.writeU16(6);
    writeStdString(inner, '/appearance/crate.iff');
    // visible (index 12)
    inner.writeU16(12);
    inner.writeBool(true);

    const result = tryDecodeDelta(
      ObjectTypeTags.RCNO,
      BaselinePackageIds.SHARED,
      inner.toBytes(),
      (b) => new ReadIterator(b),
    );
    expect(result).not.toBeNull();
    const data = result?.data as {
      complexity?: number;
      nameStringId?: { table: string; textIndex: number; text: string };
      objectName?: string;
      appearanceData?: string;
      visible?: boolean;
    };
    expect(data.complexity).toBeCloseTo(1.5);
    expect(data.nameStringId).toEqual({
      table: 'resource/resource_names',
      textIndex: 0,
      text: 'iron',
    });
    expect(data.objectName).toBe('Heshurium');
    expect(data.appearanceData).toBe('/appearance/crate.iff');
    expect(data.visible).toBe(true);
  });

  it('decodes the AutoDeltaSet<i32> components field (INSERT + ERASE + CLEAR)', () => {
    // [u16 count=1][u16 fieldIndex=7 (components)]
    //   [u32 commandCount=3][u32 baselineCommandCount=0]
    //   [u8 INSERT][i32 17]
    //   [u8 ERASE][i32 5]
    //   [u8 CLEAR]
    const inner = new ByteStream();
    inner.writeU16(1);
    inner.writeU16(7);
    inner.writeU32(3); // commandCount
    inner.writeU32(0); // baselineCommandCount
    inner.writeU8(AutoDeltaSetCommand.INSERT);
    inner.writeI32(17);
    inner.writeU8(AutoDeltaSetCommand.ERASE);
    inner.writeI32(5);
    inner.writeU8(AutoDeltaSetCommand.CLEAR);

    const result = tryDecodeDelta(
      ObjectTypeTags.RCNO,
      BaselinePackageIds.SHARED,
      inner.toBytes(),
      (b) => new ReadIterator(b),
    );
    expect(result).not.toBeNull();
    const data = result?.data as {
      components?: { kind: string; value?: number }[];
    };
    expect(Object.keys(data ?? {})).toEqual(['components']);
    expect(data.components).toEqual([
      { kind: 'insert', value: 17 },
      { kind: 'erase', value: 5 },
      { kind: 'clear' },
    ]);
  });

  it('returns null on out-of-range fieldIndex (swallows throw)', () => {
    const inner = new ByteStream();
    inner.writeU16(1);
    inner.writeU16(99); // out of range — package has 15 fields (0..14)
    inner.writeI32(0);

    const result = tryDecodeDelta(
      ObjectTypeTags.RCNO,
      BaselinePackageIds.SHARED,
      inner.toBytes(),
      (b) => new ReadIterator(b),
    );
    expect(result).toBeNull();
  });
});
