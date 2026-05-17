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
import type { CreatureObjectClientServerBaseline } from './creature-object-baseline-1.js';
import { tryDecodeDelta } from './delta-registry.js';
import { BaselinePackageIds, ObjectTypeTags } from './registry.js';

// Side-effect: ensure the CREO/CLIENT_SERVER delta decoder is registered.
import './creature-object-delta-1.js';

const TYPE_ID = ObjectTypeTags.CREO;
const PACKAGE_ID = BaselinePackageIds.CLIENT_SERVER;

function decode(payload: Uint8Array) {
  return tryDecodeDelta(TYPE_ID, PACKAGE_ID, payload, (b) => new ReadIterator(b));
}

describe('CreatureObjectClientServerDelta', () => {
  it('decodes a single-field delta (cashBalance only)', () => {
    const inner = new ByteStream();
    inner.writeU16(1); // count
    inner.writeU16(1); // fieldIndex 1 = cashBalance
    inner.writeI32(987_654);

    const result = decode(inner.toBytes());
    expect(result).not.toBeNull();
    expect(result?.kind).toBe('CreatureObjectClientServerDelta');

    const data = result?.data as Partial<CreatureObjectClientServerBaseline>;
    expect(data.cashBalance).toBe(987_654);
    // bankBalance / maxAttributes / skills must be absent
    expect('bankBalance' in data).toBe(false);
    expect('maxAttributes' in data).toBe(false);
    expect('skills' in data).toBe(false);
    expect(Object.keys(data)).toEqual(['cashBalance']);
  });

  it('decodes a multi-field delta (bankBalance + cashBalance)', () => {
    const inner = new ByteStream();
    inner.writeU16(2);
    // fieldIndex 0 = bankBalance
    inner.writeU16(0);
    inner.writeI32(1_000_000);
    // fieldIndex 1 = cashBalance
    inner.writeU16(1);
    inner.writeI32(-50);

    const result = decode(inner.toBytes());
    expect(result).not.toBeNull();
    const data = result?.data as Partial<CreatureObjectClientServerBaseline>;
    expect(data.bankBalance).toBe(1_000_000);
    expect(data.cashBalance).toBe(-50);
    expect('maxAttributes' in data).toBe(false);
    expect('skills' in data).toBe(false);
  });

  it('decodes an AutoDeltaVector<i32> command on maxAttributes (SET at index 0)', () => {
    const inner = new ByteStream();
    inner.writeU16(1);
    inner.writeU16(2); // fieldIndex 2 = maxAttributes
    // AutoDeltaVector packDelta: [u32 commandCount][u32 baselineCommandCount] then commands
    inner.writeU32(1); // commandCount
    inner.writeU32(0); // baselineCommandCount
    inner.writeU8(AutoDeltaVectorCommand.SET);
    inner.writeU16(0); // index 0 = Health
    inner.writeI32(1500);

    const result = decode(inner.toBytes());
    expect(result).not.toBeNull();
    const data = result?.data as Partial<CreatureObjectClientServerBaseline> & {
      maxAttributes?: AutoDeltaVectorDelta<number>[];
    };
    expect(data.maxAttributes).toEqual([{ kind: 'set', index: 0, value: 1500 }]);
  });

  it('decodes an AutoDeltaSet<std::string> command on skills (INSERT)', () => {
    const inner = new ByteStream();
    inner.writeU16(1);
    inner.writeU16(3); // fieldIndex 3 = skills
    // AutoDeltaSet packDelta: [u32 commandCount][u32 baselineCommandCount] then commands
    inner.writeU32(1);
    inner.writeU32(0);
    inner.writeU8(AutoDeltaSetCommand.INSERT);
    writeStdString(inner, 'class_artisan_phase1_novice');

    const result = decode(inner.toBytes());
    expect(result).not.toBeNull();
    const data = result?.data as Partial<CreatureObjectClientServerBaseline> & {
      skills?: AutoDeltaSetDelta<string>[];
    };
    expect(data.skills).toEqual([{ kind: 'insert', value: 'class_artisan_phase1_novice' }]);
  });

  it('returns null on out-of-range fieldIndex (swallows throw)', () => {
    const inner = new ByteStream();
    inner.writeU16(1);
    inner.writeU16(99); // package only has 4 fields (0-3)
    inner.writeI32(0);

    const result = decode(inner.toBytes());
    expect(result).toBeNull();
  });
});
