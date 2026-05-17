import { describe, expect, it } from 'vitest';

import { ByteStream } from '../../../archive/byte-stream.js';
import { ReadIterator } from '../../../archive/read-iterator.js';
import { writeStdString } from '../../../archive/string.js';
import {
  AutoDeltaSetCommand,
  type AutoDeltaSetDelta,
  AutoDeltaVectorCommand,
  type AutoDeltaVectorDelta,
} from './auto-delta-delta-codecs.js';
import type {
  CreatureObjectSharedNpBaseline,
  PlayerAndShipPair,
} from './creature-object-baseline-6.js';
import { tryDecodeDelta } from './delta-registry.js';
import { BaselinePackageIds, ObjectTypeTags } from './registry.js';

// Side-effect: ensure the CREO/SHARED_NP delta decoder is registered.
import './creature-object-delta-6.js';

const TYPE_ID = ObjectTypeTags.CREO;
const PACKAGE_ID = BaselinePackageIds.SHARED_NP;

function decode(payload: Uint8Array) {
  return tryDecodeDelta(TYPE_ID, PACKAGE_ID, payload, (b) => new ReadIterator(b));
}

describe('CreatureObjectSharedNpDelta', () => {
  it('decodes a single-field delta on level (primitive i16, fieldIndex 8)', () => {
    const inner = new ByteStream();
    inner.writeU16(1); // count
    inner.writeU16(8); // fieldIndex 8 = level
    inner.writeI16(85);

    const result = decode(inner.toBytes());
    expect(result).not.toBeNull();
    expect(result?.kind).toBe('CreatureObjectSharedNpDelta');

    const data = result?.data as Partial<CreatureObjectSharedNpBaseline>;
    expect(data.level).toBe(85);
    expect(Object.keys(data)).toEqual(['level']);
  });

  it('decodes a single-field delta on mood (primitive u8, fieldIndex 18)', () => {
    const inner = new ByteStream();
    inner.writeU16(1);
    inner.writeU16(18); // fieldIndex 18 = mood
    inner.writeU8(7); // arbitrary mood enum value

    const result = decode(inner.toBytes());
    expect(result).not.toBeNull();
    const data = result?.data as Partial<CreatureObjectSharedNpBaseline>;
    expect(data.mood).toBe(7);
    expect(Object.keys(data)).toEqual(['mood']);
  });

  it('decodes a multi-field delta covering 3+ fields (level, mood, guildId)', () => {
    const inner = new ByteStream();
    inner.writeU16(3);
    // level (i16) at index 8
    inner.writeU16(8);
    inner.writeI16(50);
    // guildId (i32) at index 15
    inner.writeU16(15);
    inner.writeI32(0x4242_4242);
    // mood (u8) at index 18
    inner.writeU16(18);
    inner.writeU8(3);

    const result = decode(inner.toBytes());
    expect(result).not.toBeNull();
    const data = result?.data as Partial<CreatureObjectSharedNpBaseline>;
    expect(data.level).toBe(50);
    expect(data.guildId).toBe(0x4242_4242);
    expect(data.mood).toBe(3);
    // Unmentioned fields must be absent
    expect('cashBalance' in data).toBe(false);
    expect('inCombat' in data).toBe(false);
    expect('buffs' in data).toBe(false);
  });

  it('decodes an AutoDeltaSet<NetworkId> INSERT on accessList (fieldIndex 5)', () => {
    const inner = new ByteStream();
    inner.writeU16(1);
    inner.writeU16(5); // fieldIndex 5 = accessList
    // AutoDeltaSet packDelta header
    inner.writeU32(1); // commandCount
    inner.writeU32(0); // baselineCommandCount
    inner.writeU8(AutoDeltaSetCommand.INSERT);
    inner.writeI64(0x0000_0000_dead_beefn); // NetworkId

    const result = decode(inner.toBytes());
    expect(result).not.toBeNull();
    const data = result?.data as Partial<CreatureObjectSharedNpBaseline> & {
      accessList?: AutoDeltaSetDelta<bigint>[];
    };
    expect(data.accessList).toEqual([{ kind: 'insert', value: 0xdeadbeefn }]);
  });

  it('decodes an AutoDeltaVector<i32> SET on totalAttributes (fieldIndex 21)', () => {
    const inner = new ByteStream();
    inner.writeU16(1);
    inner.writeU16(21); // fieldIndex 21 = totalAttributes
    // AutoDeltaVector packDelta header
    inner.writeU32(1); // commandCount
    inner.writeU32(0); // baselineCommandCount
    inner.writeU8(AutoDeltaVectorCommand.SET);
    inner.writeU16(0); // index 0 = Health
    inner.writeI32(1200);

    const result = decode(inner.toBytes());
    expect(result).not.toBeNull();
    const data = result?.data as Partial<CreatureObjectSharedNpBaseline> & {
      totalAttributes?: AutoDeltaVectorDelta<number>[];
    };
    expect(data.totalAttributes).toEqual([{ kind: 'set', index: 0, value: 1200 }]);
  });

  it('decodes a groupInviter delta (PlayerAndShipPair — NOT AutoDelta, inline tuple at fieldIndex 14)', () => {
    const inner = new ByteStream();
    inner.writeU16(1);
    inner.writeU16(14); // fieldIndex 14 = groupInviter
    // PlayerAndShipPair = pair<pair<NetworkId, string>, NetworkId>
    inner.writeI64(0x1234_5678n); // inviter NetworkId
    writeStdString(inner, 'Alice');
    inner.writeI64(0n); // ship NetworkId (not on a ship)

    const result = decode(inner.toBytes());
    expect(result).not.toBeNull();
    const data = result?.data as Partial<CreatureObjectSharedNpBaseline> & {
      groupInviter?: PlayerAndShipPair;
    };
    expect(data.groupInviter).toEqual({
      inviter: 0x1234_5678n,
      inviterName: 'Alice',
      ship: 0n,
    });
  });

  it('returns null on out-of-range fieldIndex (package has 35 fields, 0-34)', () => {
    const inner = new ByteStream();
    inner.writeU16(1);
    inner.writeU16(35); // out of range — valid indices are 0-34
    inner.writeI32(0);

    const result = decode(inner.toBytes());
    expect(result).toBeNull();
  });
});
