import { describe, expect, it } from 'vitest';

import { ByteStream } from '../../../archive/byte-stream.js';
import { ReadIterator } from '../../../archive/read-iterator.js';
import { tryDecodeDelta } from './delta-registry.js';
import type { PlayerObjectClientServerBaseline } from './player-object-baseline-1.js';
import { BaselinePackageIds, ObjectTypeTags } from './registry.js';

// Side-effect: ensure the PLAY/CLIENT_SERVER delta decoder is registered.
import './player-object-delta-1.js';

const TYPE_ID = ObjectTypeTags.PLAY;
const PACKAGE_ID = BaselinePackageIds.CLIENT_SERVER;

function decode(payload: Uint8Array) {
  return tryDecodeDelta(TYPE_ID, PACKAGE_ID, payload, (b) => new ReadIterator(b));
}

// Note: PLAY p1 only contains the two ServerObject auth-client primitives
// (bankBalance, cashBalance). PlayerObject's container fields (waypoints,
// quests, friends, etc.) live in package 8 (FirstParent auth-client server)
// rather than package 1, so no AutoDelta* container is exercisable here.
// The container-codec coverage tests live with the package-8 delta decoder.
describe('PlayerObjectClientServerDelta', () => {
  it('decodes a single-field delta (bankBalance only)', () => {
    const inner = new ByteStream();
    inner.writeU16(1); // count
    inner.writeU16(0); // fieldIndex 0 = bankBalance
    inner.writeI32(2_500_000);

    const result = decode(inner.toBytes());
    expect(result).not.toBeNull();
    expect(result?.kind).toBe('PlayerObjectClientServerDelta');

    const data = result?.data as Partial<PlayerObjectClientServerBaseline>;
    expect(data.bankBalance).toBe(2_500_000);
    expect('cashBalance' in data).toBe(false);
    expect(Object.keys(data)).toEqual(['bankBalance']);
  });

  it('decodes a single-field delta (cashBalance only, negative value)', () => {
    // A payout / debit can drive cashBalance negative briefly between credit
    // moves on the server, so the i32 must be signed.
    const inner = new ByteStream();
    inner.writeU16(1);
    inner.writeU16(1); // fieldIndex 1 = cashBalance
    inner.writeI32(-12_345);

    const result = decode(inner.toBytes());
    expect(result).not.toBeNull();
    const data = result?.data as Partial<PlayerObjectClientServerBaseline>;
    expect(data.cashBalance).toBe(-12_345);
    expect('bankBalance' in data).toBe(false);
  });

  it('decodes a multi-field delta (bankBalance + cashBalance)', () => {
    const inner = new ByteStream();
    inner.writeU16(2);
    // fieldIndex 0 = bankBalance
    inner.writeU16(0);
    inner.writeI32(1_000_000);
    // fieldIndex 1 = cashBalance
    inner.writeU16(1);
    inner.writeI32(42);

    const result = decode(inner.toBytes());
    expect(result).not.toBeNull();
    expect(result?.kind).toBe('PlayerObjectClientServerDelta');

    const data = result?.data as Partial<PlayerObjectClientServerBaseline>;
    expect(data.bankBalance).toBe(1_000_000);
    expect(data.cashBalance).toBe(42);
    expect(Object.keys(data).sort()).toEqual(['bankBalance', 'cashBalance']);
  });

  it('returns null on out-of-range fieldIndex (swallows throw)', () => {
    const inner = new ByteStream();
    inner.writeU16(1);
    inner.writeU16(99); // package only has 2 fields (0-1)
    inner.writeI32(0);

    const result = decode(inner.toBytes());
    expect(result).toBeNull();
  });
});
