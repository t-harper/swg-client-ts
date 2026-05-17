import { describe, expect, it } from 'vitest';

import { ByteStream } from '../../../archive/byte-stream.js';
import { ReadIterator } from '../../../archive/read-iterator.js';
import { writeStdString } from '../../../archive/string.js';
import { writeUnicodeString } from '../../../archive/unicode-string.js';
import { AutoDeltaSetCommand } from './auto-delta-delta-codecs.js';
import {
  BuildingObjectSharedDeltaDecoder,
  BuildingObjectSharedDeltaKind,
} from './building-object-delta-3.js';
import { deltaRegistry, tryDecodeDelta } from './delta-registry.js';
import { BaselinePackageIds, ObjectTypeTags } from './registry.js';
import { StringIdCodec } from './string-id.js';

// Side-effect: ensure delta decoders are registered. The direct import above
// is what registers the BUIO/SHARED decoder; `./index.js` pulls in the other
// built-ins so the deltaRegistry is fully warmed.
import './index.js';

describe('BuildingObjectSharedDeltaDecoder', () => {
  it('is registered for (BUIO, SHARED=3) with all 13 fields in the correct order', () => {
    expect(BuildingObjectSharedDeltaDecoder.typeId).toBe(ObjectTypeTags.BUIO);
    expect(BuildingObjectSharedDeltaDecoder.packageId).toBe(BaselinePackageIds.SHARED);
    expect(BuildingObjectSharedDeltaDecoder.kind).toBe(BuildingObjectSharedDeltaKind);
    expect(BuildingObjectSharedDeltaDecoder.fields).toHaveLength(13);
    expect(BuildingObjectSharedDeltaDecoder.fields.map((f) => f.name)).toEqual([
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
      // BuildingObject adds zero SHARED variables.
    ]);
  });

  it('discoverable via deltaRegistry.get(BUIO, SHARED)', () => {
    const found = deltaRegistry.get(ObjectTypeTags.BUIO, BaselinePackageIds.SHARED);
    expect(found).toBe(BuildingObjectSharedDeltaDecoder);
  });

  it('decodes a single-field delta (condition only — structure takes damage)', () => {
    // [u16 count=1][u16 fieldIndex=8 (condition)][i32 -500]
    const inner = new ByteStream();
    inner.writeU16(1);
    inner.writeU16(8);
    inner.writeI32(-500);

    const result = tryDecodeDelta(
      ObjectTypeTags.BUIO,
      BaselinePackageIds.SHARED,
      inner.toBytes(),
      (b) => new ReadIterator(b),
    );
    expect(result).not.toBeNull();
    expect(result?.kind).toBe(BuildingObjectSharedDeltaKind);
    // Sparse: only condition should be present.
    expect(Object.keys(result?.data ?? {})).toEqual(['condition']);
    expect((result?.data as { condition?: number }).condition).toBe(-500);
  });

  it('decodes a multi-field delta (damageTaken + maxHitPoints + visible)', () => {
    // AutoDeltaByteStream::packDeltas iterates members by ascending index,
    // so on-wire order is 10, 11, 12.
    const inner = new ByteStream();
    inner.writeU16(3);
    // damageTaken (index 10)
    inner.writeU16(10);
    inner.writeI32(2500);
    // maxHitPoints (index 11)
    inner.writeU16(11);
    inner.writeI32(50_000);
    // visible (index 12)
    inner.writeU16(12);
    inner.writeBool(true);

    const result = tryDecodeDelta(
      ObjectTypeTags.BUIO,
      BaselinePackageIds.SHARED,
      inner.toBytes(),
      (b) => new ReadIterator(b),
    );
    expect(result).not.toBeNull();
    expect(result?.kind).toBe(BuildingObjectSharedDeltaKind);
    const data = result?.data as {
      damageTaken?: number;
      maxHitPoints?: number;
      visible?: boolean;
    };
    expect(Object.keys(data ?? {}).sort()).toEqual(['damageTaken', 'maxHitPoints', 'visible']);
    expect(data.damageTaken).toBe(2500);
    expect(data.maxHitPoints).toBe(50_000);
    expect(data.visible).toBe(true);
  });

  it('decodes a delta touching mixed primitive types (complexity, nameStringId, objectName, appearanceData)', () => {
    const inner = new ByteStream();
    inner.writeU16(4);
    // complexity (index 0)
    inner.writeU16(0);
    inner.writeF32(15.0);
    // nameStringId (index 1)
    inner.writeU16(1);
    StringIdCodec.encode(inner, { table: 'building_n', textIndex: 0, text: 'naboo_small_house' });
    // objectName (index 2) — player's house-name override
    inner.writeU16(2);
    writeUnicodeString(inner, "Travis's Beach House");
    // appearanceData (index 6)
    inner.writeU16(6);
    writeStdString(inner, 'object/building/player/shared_player_house_naboo_small.iff');

    const result = tryDecodeDelta(
      ObjectTypeTags.BUIO,
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
    };
    expect(data.complexity).toBeCloseTo(15.0);
    expect(data.nameStringId).toEqual({
      table: 'building_n',
      textIndex: 0,
      text: 'naboo_small_house',
    });
    expect(data.objectName).toBe("Travis's Beach House");
    expect(data.appearanceData).toBe('object/building/player/shared_player_house_naboo_small.iff');
  });

  it('decodes the AutoDeltaSet<i32> components field with a mix of INSERT, ERASE, and CLEAR', () => {
    // [u16 count=1][u16 fieldIndex=7 (components)]
    //   [u32 commandCount=3][u32 baselineCommandCount=0]
    //   [u8 INSERT][i32 100]
    //   [u8 ERASE][i32 7]
    //   [u8 CLEAR]
    const inner = new ByteStream();
    inner.writeU16(1);
    inner.writeU16(7);
    inner.writeU32(3); // commandCount
    inner.writeU32(0); // baselineCommandCount
    inner.writeU8(AutoDeltaSetCommand.INSERT);
    inner.writeI32(100);
    inner.writeU8(AutoDeltaSetCommand.ERASE);
    inner.writeI32(7);
    inner.writeU8(AutoDeltaSetCommand.CLEAR);

    const result = tryDecodeDelta(
      ObjectTypeTags.BUIO,
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
      { kind: 'insert', value: 100 },
      { kind: 'erase', value: 7 },
      { kind: 'clear' },
    ]);
  });

  it('returns null on out-of-range fieldIndex (swallows throw)', () => {
    const inner = new ByteStream();
    inner.writeU16(1);
    inner.writeU16(99); // out of range — package has 13 fields (0..12)
    inner.writeI32(0);

    const result = tryDecodeDelta(
      ObjectTypeTags.BUIO,
      BaselinePackageIds.SHARED,
      inner.toBytes(),
      (b) => new ReadIterator(b),
    );
    expect(result).toBeNull();
  });
});
