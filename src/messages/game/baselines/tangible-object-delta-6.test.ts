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
import { tryDecodeDelta } from './delta-registry.js';
import { BaselinePackageIds, ObjectTypeTags } from './registry.js';
import type {
  TangibleObjectEffect,
  TangibleObjectSharedNpBaseline,
} from './tangible-object-baseline-6.js';

// Side-effect: ensure the TANO/SHARED_NP delta decoder is registered.
import './tangible-object-delta-6.js';

const TYPE_ID = ObjectTypeTags.TANO;
const PACKAGE_ID = BaselinePackageIds.SHARED_NP;

function decode(payload: Uint8Array) {
  return tryDecodeDelta(TYPE_ID, PACKAGE_ID, payload, (b) => new ReadIterator(b));
}

describe('TangibleObjectSharedNpDelta', () => {
  it('decodes a single-field delta on inCombat (bool, fieldIndex 2)', () => {
    const inner = new ByteStream();
    inner.writeU16(1); // count
    inner.writeU16(2); // fieldIndex 2 = inCombat
    inner.writeBool(true);

    const result = decode(inner.toBytes());
    expect(result).not.toBeNull();
    expect(result?.kind).toBe('TangibleObjectSharedNpDelta');

    const data = result?.data as Partial<TangibleObjectSharedNpBaseline>;
    expect(data.inCombat).toBe(true);
    expect(Object.keys(data)).toEqual(['inCombat']);
  });

  it('decodes a single-field delta on mapColorOverride (u32, fieldIndex 4)', () => {
    const inner = new ByteStream();
    inner.writeU16(1);
    inner.writeU16(4); // fieldIndex 4 = mapColorOverride
    inner.writeU32(0xff8040c0);

    const result = decode(inner.toBytes());
    expect(result).not.toBeNull();
    const data = result?.data as Partial<TangibleObjectSharedNpBaseline>;
    expect(data.mapColorOverride).toBe(0xff8040c0);
    expect(Object.keys(data)).toEqual(['mapColorOverride']);
  });

  it('decodes a multi-field delta (authServerProcessId + inCombat + mapColorOverride)', () => {
    const inner = new ByteStream();
    inner.writeU16(3);
    // fieldIndex 0 = authServerProcessId (u32)
    inner.writeU16(0);
    inner.writeU32(0x4242_4242);
    // fieldIndex 2 = inCombat (bool)
    inner.writeU16(2);
    inner.writeBool(false);
    // fieldIndex 4 = mapColorOverride (u32)
    inner.writeU16(4);
    inner.writeU32(0x0000_0001);

    const result = decode(inner.toBytes());
    expect(result).not.toBeNull();
    const data = result?.data as Partial<TangibleObjectSharedNpBaseline>;
    expect(data.authServerProcessId).toBe(0x4242_4242);
    expect(data.inCombat).toBe(false);
    expect(data.mapColorOverride).toBe(0x0000_0001);
    expect('accessList' in data).toBe(false);
    expect('effects' in data).toBe(false);
  });

  it('decodes an AutoDeltaSet<NetworkId> INSERT on accessList (fieldIndex 5)', () => {
    const inner = new ByteStream();
    inner.writeU16(1);
    inner.writeU16(5); // fieldIndex 5 = accessList
    // AutoDeltaSet packDelta header
    inner.writeU32(1); // commandCount
    inner.writeU32(0); // baselineCommandCount
    inner.writeU8(AutoDeltaSetCommand.INSERT);
    inner.writeI64(0x0000_0000_dead_beefn); // NetworkId of player granted access

    const result = decode(inner.toBytes());
    expect(result).not.toBeNull();
    const data = result?.data as Partial<TangibleObjectSharedNpBaseline> & {
      accessList?: AutoDeltaSetDelta<bigint>[];
    };
    expect(data.accessList).toEqual([{ kind: 'insert', value: 0xdeadbeefn }]);
  });

  it('decodes an AutoDeltaSet<i32> ERASE + INSERT on guildAccessList (fieldIndex 6)', () => {
    const inner = new ByteStream();
    inner.writeU16(1);
    inner.writeU16(6); // fieldIndex 6 = guildAccessList
    // AutoDeltaSet packDelta header
    inner.writeU32(2); // commandCount
    inner.writeU32(0); // baselineCommandCount
    // ERASE one guild
    inner.writeU8(AutoDeltaSetCommand.ERASE);
    inner.writeI32(101);
    // INSERT another
    inner.writeU8(AutoDeltaSetCommand.INSERT);
    inner.writeI32(202);

    const result = decode(inner.toBytes());
    expect(result).not.toBeNull();
    const data = result?.data as Partial<TangibleObjectSharedNpBaseline> & {
      guildAccessList?: AutoDeltaSetDelta<number>[];
    };
    expect(data.guildAccessList).toEqual([
      { kind: 'erase', value: 101 },
      { kind: 'insert', value: 202 },
    ]);
  });

  it('decodes an AutoDeltaMap ADD on effects (fieldIndex 7)', () => {
    const inner = new ByteStream();
    inner.writeU16(1);
    inner.writeU16(7); // fieldIndex 7 = effects
    // AutoDeltaMap packDelta header
    inner.writeU32(1); // commandCount
    inner.writeU32(0); // baselineCommandCount
    // ADD command: [u8 cmd][K key][V value]
    inner.writeU8(AutoDeltaMapCommand.ADD);
    // key = effect name (std::string)
    writeStdString(inner, 'kashyyyk_armor_glow');
    // value = pair<string, pair<string, pair<Vector, float>>>
    writeStdString(inner, 'clienteffect/armor_glow.cef'); // effectScript
    writeStdString(inner, 'hp_chest'); // hardpoint
    inner.writeF32(0.5); // offset.x  (f32-exact)
    inner.writeF32(0.25); // offset.y (f32-exact)
    inner.writeF32(-1.0); // offset.z (f32-exact)
    inner.writeF32(1.5); // scale     (f32-exact)

    const result = decode(inner.toBytes());
    expect(result).not.toBeNull();
    const data = result?.data as Partial<TangibleObjectSharedNpBaseline> & {
      effects?: AutoDeltaMapDelta<string, Omit<TangibleObjectEffect, 'name'>>[];
    };
    expect(data.effects).toEqual([
      {
        kind: 'add',
        key: 'kashyyyk_armor_glow',
        value: {
          effectScript: 'clienteffect/armor_glow.cef',
          hardpoint: 'hp_chest',
          offset: { x: 0.5, y: 0.25, z: -1.0 },
          scale: 1.5,
        },
      },
    ]);
  });

  it('returns null on out-of-range fieldIndex (package has 8 fields, 0-7)', () => {
    const inner = new ByteStream();
    inner.writeU16(1);
    inner.writeU16(99); // out of range — valid indices are 0-7
    inner.writeI32(0);

    const result = decode(inner.toBytes());
    expect(result).toBeNull();
  });
});
