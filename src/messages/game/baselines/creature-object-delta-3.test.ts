import { describe, expect, it } from 'vitest';

import { ByteStream } from '../../../archive/byte-stream.js';
import { ReadIterator } from '../../../archive/read-iterator.js';
import { writeStdString } from '../../../archive/string.js';
import { writeUnicodeString } from '../../../archive/unicode-string.js';
import { AutoDeltaSetCommand } from './auto-delta-delta-codecs.js';
import {
  CreatureObjectSharedDeltaDecoder,
  CreatureObjectSharedDeltaKind,
} from './creature-object-delta-3.js';
import { deltaRegistry, tryDecodeDelta } from './delta-registry.js';
import { BaselinePackageIds, ObjectTypeTags } from './registry.js';
import { StringIdCodec } from './string-id.js';

// Side-effect: ensure delta decoders are registered.
import './index.js';

describe('CreatureObjectSharedDeltaDecoder', () => {
  it('is registered for (CREO, SHARED=3) with all 19 fields in the correct order', () => {
    expect(CreatureObjectSharedDeltaDecoder.typeId).toBe(ObjectTypeTags.CREO);
    expect(CreatureObjectSharedDeltaDecoder.packageId).toBe(BaselinePackageIds.SHARED);
    expect(CreatureObjectSharedDeltaDecoder.kind).toBe(CreatureObjectSharedDeltaKind);
    expect(CreatureObjectSharedDeltaDecoder.fields).toHaveLength(19);
    expect(CreatureObjectSharedDeltaDecoder.fields.map((f) => f.name)).toEqual([
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
      // CreatureObject
      'posture',
      'rank',
      'masterId',
      'scaleFactor',
      'shockWounds',
      'states',
    ]);
  });

  it('discoverable via deltaRegistry.get(CREO, SHARED)', () => {
    const found = deltaRegistry.get(ObjectTypeTags.CREO, BaselinePackageIds.SHARED);
    expect(found).toBe(CreatureObjectSharedDeltaDecoder);
  });

  it('decodes a single-field delta (posture only — sit down)', () => {
    // [u16 count=1][u16 fieldIndex=13 (posture)][i8 8 (Sitting)]
    const inner = new ByteStream();
    inner.writeU16(1);
    inner.writeU16(13);
    inner.writeI8(8);

    const result = tryDecodeDelta(
      ObjectTypeTags.CREO,
      BaselinePackageIds.SHARED,
      inner.toBytes(),
      (b) => new ReadIterator(b),
    );
    expect(result).not.toBeNull();
    expect(result?.kind).toBe(CreatureObjectSharedDeltaKind);
    // Sparse: only posture should be present.
    expect(Object.keys(result?.data ?? {})).toEqual(['posture']);
    expect((result?.data as { posture?: number }).posture).toBe(8);
  });

  it('decodes a multi-field delta (scaleFactor + states + masterId)', () => {
    // Three fields, written in the order their indices appear on the wire.
    // The server's AutoDeltaByteStream::packDeltas iterates members by
    // increasing index, so the on-wire order is ascending: 15, 16, 18.
    const inner = new ByteStream();
    inner.writeU16(3);
    // masterId (index 15) = 0x1122334455667788n
    inner.writeU16(15);
    inner.writeI64(0x1122_3344_5566_7788n);
    // scaleFactor (index 16) = 1.75
    inner.writeU16(16);
    inner.writeF32(1.75);
    // states (index 18) = a combat-state bitmask
    inner.writeU16(18);
    inner.writeU64(0x0000_0000_0000_00ffn);

    const result = tryDecodeDelta(
      ObjectTypeTags.CREO,
      BaselinePackageIds.SHARED,
      inner.toBytes(),
      (b) => new ReadIterator(b),
    );
    expect(result).not.toBeNull();
    expect(result?.kind).toBe(CreatureObjectSharedDeltaKind);
    const data = result?.data as {
      masterId?: bigint;
      scaleFactor?: number;
      states?: bigint;
    };
    expect(Object.keys(data ?? {}).sort()).toEqual(['masterId', 'scaleFactor', 'states']);
    expect(data.masterId).toBe(0x1122_3344_5566_7788n);
    expect(data.scaleFactor).toBeCloseTo(1.75);
    expect(data.states).toBe(0x0000_0000_0000_00ffn);
  });

  it('decodes a delta touching mixed primitive types (complexity, nameStringId, objectName, appearanceData, visible)', () => {
    const inner = new ByteStream();
    inner.writeU16(5);
    // complexity (index 0)
    inner.writeU16(0);
    inner.writeF32(2.5);
    // nameStringId (index 1)
    inner.writeU16(1);
    StringIdCodec.encode(inner, { table: 'obj_n', textIndex: 0, text: 'test_name' });
    // objectName (index 2)
    inner.writeU16(2);
    writeUnicodeString(inner, 'Renamed Creature');
    // appearanceData (index 6)
    inner.writeU16(6);
    writeStdString(inner, '/appearance/new.iff');
    // visible (index 12)
    inner.writeU16(12);
    inner.writeBool(false);

    const result = tryDecodeDelta(
      ObjectTypeTags.CREO,
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
    expect(data.complexity).toBeCloseTo(2.5);
    expect(data.nameStringId).toEqual({ table: 'obj_n', textIndex: 0, text: 'test_name' });
    expect(data.objectName).toBe('Renamed Creature');
    expect(data.appearanceData).toBe('/appearance/new.iff');
    expect(data.visible).toBe(false);
  });

  it('decodes the AutoDeltaSet<i32> components field (INSERT command)', () => {
    // [u16 count=1][u16 fieldIndex=7 (components)]
    //   [u32 commandCount=1][u32 baselineCommandCount=0]
    //   [u8 INSERT=1][i32 42]
    const inner = new ByteStream();
    inner.writeU16(1);
    inner.writeU16(7);
    inner.writeU32(1); // commandCount
    inner.writeU32(0); // baselineCommandCount
    inner.writeU8(AutoDeltaSetCommand.INSERT);
    inner.writeI32(42);

    const result = tryDecodeDelta(
      ObjectTypeTags.CREO,
      BaselinePackageIds.SHARED,
      inner.toBytes(),
      (b) => new ReadIterator(b),
    );
    expect(result).not.toBeNull();
    const data = result?.data as {
      components?: { kind: string; value?: number }[];
    };
    expect(Object.keys(data ?? {})).toEqual(['components']);
    expect(data.components).toEqual([{ kind: 'insert', value: 42 }]);
  });

  it('decodes AutoDeltaSet<i32> components with a mix of INSERT, ERASE, and CLEAR', () => {
    const inner = new ByteStream();
    inner.writeU16(1);
    inner.writeU16(7); // components
    inner.writeU32(3); // commandCount
    inner.writeU32(0); // baselineCommandCount
    inner.writeU8(AutoDeltaSetCommand.INSERT);
    inner.writeI32(100);
    inner.writeU8(AutoDeltaSetCommand.ERASE);
    inner.writeI32(7);
    inner.writeU8(AutoDeltaSetCommand.CLEAR);

    const result = tryDecodeDelta(
      ObjectTypeTags.CREO,
      BaselinePackageIds.SHARED,
      inner.toBytes(),
      (b) => new ReadIterator(b),
    );
    expect(result).not.toBeNull();
    const data = result?.data as {
      components?: { kind: string; value?: number }[];
    };
    expect(data.components).toEqual([
      { kind: 'insert', value: 100 },
      { kind: 'erase', value: 7 },
      { kind: 'clear' },
    ]);
  });

  it('returns null on out-of-range fieldIndex (swallows throw)', () => {
    const inner = new ByteStream();
    inner.writeU16(1);
    inner.writeU16(99); // out of range — package has 19 fields (0..18)
    inner.writeI32(0);

    const result = tryDecodeDelta(
      ObjectTypeTags.CREO,
      BaselinePackageIds.SHARED,
      inner.toBytes(),
      (b) => new ReadIterator(b),
    );
    expect(result).toBeNull();
  });
});
