import { describe, expect, it } from 'vitest';

import { ByteStream } from '../../../archive/byte-stream.js';
import { ReadIterator } from '../../../archive/read-iterator.js';
import { writeStdString } from '../../../archive/string.js';
import {
  AutoDeltaMapCommand,
  type AutoDeltaMapDelta,
  AutoDeltaSetCommand,
  type AutoDeltaSetDelta,
} from './auto-delta-delta-codecs.js';
import type { BuildingObjectSharedNpBaseline } from './building-object-baseline-6.js';
import { tryDecodeDelta } from './delta-registry.js';
import { BaselinePackageIds, ObjectTypeTags } from './registry.js';
import type { StringIdValue } from './string-id.js';

// Side-effect: ensure the BUIO/SHARED_NP delta decoder is registered.
import './building-object-delta-6.js';

const TYPE_ID = ObjectTypeTags.BUIO;
const PACKAGE_ID = BaselinePackageIds.SHARED_NP;

function decode(payload: Uint8Array) {
  return tryDecodeDelta(TYPE_ID, PACKAGE_ID, payload, (b) => new ReadIterator(b));
}

describe('BuildingObjectSharedNpDelta', () => {
  it('decodes a single-field delta on inCombat (primitive u8 bool, fieldIndex 2)', () => {
    const inner = new ByteStream();
    inner.writeU16(1); // count
    inner.writeU16(2); // fieldIndex 2 = inCombat
    inner.writeU8(1); // true

    const result = decode(inner.toBytes());
    expect(result).not.toBeNull();
    expect(result?.kind).toBe('BuildingObjectSharedNpDelta');

    const data = result?.data as Partial<BuildingObjectSharedNpBaseline>;
    expect(data.inCombat).toBe(true);
    expect(Object.keys(data)).toEqual(['inCombat']);
  });

  it('decodes a multi-field delta covering 3 primitive fields (authServerProcessId, inCombat, mapColorOverride)', () => {
    const inner = new ByteStream();
    inner.writeU16(3);
    // authServerProcessId (u32) at index 0
    inner.writeU16(0);
    inner.writeU32(0xdeadbeef);
    // inCombat (u8 bool) at index 2
    inner.writeU16(2);
    inner.writeU8(0); // false
    // mapColorOverride (u32) at index 4
    inner.writeU16(4);
    inner.writeU32(0x00ff_8800); // ARGB-ish

    const result = decode(inner.toBytes());
    expect(result).not.toBeNull();
    const data = result?.data as Partial<BuildingObjectSharedNpBaseline>;
    expect(data.authServerProcessId).toBe(0xdeadbeef);
    expect(data.inCombat).toBe(false);
    expect(data.mapColorOverride).toBe(0x00ff_8800);
    // Unmentioned fields must be absent
    expect('descriptionStringId' in data).toBe(false);
    expect('accessList' in data).toBe(false);
    expect('effects' in data).toBe(false);
  });

  it('decodes a single-field delta on descriptionStringId (StringId triple, fieldIndex 1)', () => {
    const inner = new ByteStream();
    inner.writeU16(1);
    inner.writeU16(1); // fieldIndex 1 = descriptionStringId
    // StringId: [std::string table][u32 textIndex][std::string text]
    writeStdString(inner, 'obj_n');
    inner.writeU32(0);
    writeStdString(inner, 'player_house_corellia_small');

    const result = decode(inner.toBytes());
    expect(result).not.toBeNull();
    const data = result?.data as Partial<BuildingObjectSharedNpBaseline> & {
      descriptionStringId?: StringIdValue;
    };
    expect(data.descriptionStringId).toEqual({
      table: 'obj_n',
      textIndex: 0,
      text: 'player_house_corellia_small',
    });
  });

  it('decodes an AutoDeltaSet<NetworkId> INSERT on accessList (fieldIndex 5)', () => {
    const inner = new ByteStream();
    inner.writeU16(1);
    inner.writeU16(5); // fieldIndex 5 = accessList
    // AutoDeltaSet packDelta header: [u32 commandCount][u32 baselineCommandCount]
    inner.writeU32(1);
    inner.writeU32(0);
    inner.writeU8(AutoDeltaSetCommand.INSERT);
    inner.writeI64(0x0000_0000_dead_beefn); // NetworkId

    const result = decode(inner.toBytes());
    expect(result).not.toBeNull();
    const data = result?.data as Partial<BuildingObjectSharedNpBaseline> & {
      accessList?: AutoDeltaSetDelta<bigint>[];
    };
    expect(data.accessList).toEqual([{ kind: 'insert', value: 0xdeadbeefn }]);
  });

  it('decodes an AutoDeltaMap<string, effect> ADD on effects (fieldIndex 7)', () => {
    const inner = new ByteStream();
    inner.writeU16(1);
    inner.writeU16(7); // fieldIndex 7 = effects
    // AutoDeltaMap packDelta header: [u32 commandCount][u32 baselineCommandCount]
    inner.writeU32(1);
    inner.writeU32(0);
    // ADD command: [u8 cmd][K key][V value]
    inner.writeU8(AutoDeltaMapCommand.ADD);
    writeStdString(inner, 'structure_smoke_chimney'); // key
    // effect value = [std::string effectScript][std::string hardpoint][f32 x][f32 y][f32 z][f32 scale]
    writeStdString(inner, 'appearance/eff_smoke.eft');
    writeStdString(inner, 'hp_chimney');
    inner.writeF32(0.5);
    inner.writeF32(1.25);
    inner.writeF32(-0.5);
    inner.writeF32(1.0);

    const result = decode(inner.toBytes());
    expect(result).not.toBeNull();
    const data = result?.data as Partial<BuildingObjectSharedNpBaseline> & {
      effects?: AutoDeltaMapDelta<
        string,
        {
          effectScript: string;
          hardpoint: string;
          offset: { x: number; y: number; z: number };
          scale: number;
        }
      >[];
    };
    expect(data.effects).toEqual([
      {
        kind: 'add',
        key: 'structure_smoke_chimney',
        value: {
          effectScript: 'appearance/eff_smoke.eft',
          hardpoint: 'hp_chimney',
          offset: { x: 0.5, y: 1.25, z: -0.5 },
          scale: 1.0,
        },
      },
    ]);
  });

  it('returns null on out-of-range fieldIndex (package has 8 fields, valid indices 0-7)', () => {
    const inner = new ByteStream();
    inner.writeU16(1);
    inner.writeU16(8); // out of range — valid indices are 0-7
    inner.writeU32(0);

    const result = decode(inner.toBytes());
    expect(result).toBeNull();
  });
});
