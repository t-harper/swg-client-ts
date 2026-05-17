import { describe, expect, it } from 'vitest';

import { ByteStream } from '../../../archive/byte-stream.js';
import { ReadIterator } from '../../../archive/read-iterator.js';
import { writeStdString } from '../../../archive/string.js';
import { writeUnicodeString } from '../../../archive/unicode-string.js';
import type { BitArrayValue } from './auto-delta-codecs.js';
import { deltaRegistry, tryDecodeDelta } from './delta-registry.js';
import type { PlayerObjectSharedBaseline } from './player-object-baseline-3.js';
import {
  PlayerObjectSharedDeltaDecoder,
  PlayerObjectSharedDeltaKind,
} from './player-object-delta-3.js';
import { BaselinePackageIds, ObjectTypeTags } from './registry.js';

// Side-effect: ensure the PLAY/SHARED delta decoder is registered.
import './player-object-delta-3.js';

const TYPE_ID = ObjectTypeTags.PLAY;
const PACKAGE_ID = BaselinePackageIds.SHARED;

function decode(payload: Uint8Array) {
  return tryDecodeDelta(TYPE_ID, PACKAGE_ID, payload, (b) => new ReadIterator(b));
}

describe('PlayerObjectSharedDelta', () => {
  it('is registered for (PLAY, SHARED=3) with 20 ordered fields', () => {
    expect(PlayerObjectSharedDeltaDecoder.typeId).toBe(ObjectTypeTags.PLAY);
    expect(PlayerObjectSharedDeltaDecoder.packageId).toBe(BaselinePackageIds.SHARED);
    expect(PlayerObjectSharedDeltaDecoder.kind).toBe(PlayerObjectSharedDeltaKind);
    expect(PlayerObjectSharedDeltaDecoder.fields.length).toBe(20);

    // Field-name ordering must match the baseline's decode() read order.
    const names = PlayerObjectSharedDeltaDecoder.fields.map((f) => f.name);
    expect(names).toEqual([
      'complexity',
      'nameStringId',
      'objectName',
      'volume',
      'count',
      'matchMakingCharacterProfileId',
      'matchMakingPersonalProfileId',
      'skillTitle',
      'bornDate',
      'playedTime',
      'roleIconChoice',
      'skillTemplate',
      'currentGcwPoints',
      'currentPvpKills',
      'lifetimeGcwPoints',
      'lifetimePvpKills',
      'collections',
      'collections2',
      'showBackpack',
      'showHelmet',
    ]);
  });

  it('decodes a single-field delta (skillTitle only at index 7)', () => {
    const inner = new ByteStream();
    inner.writeU16(1); // count
    inner.writeU16(7); // fieldIndex 7 = skillTitle
    writeStdString(inner, 'master_brawler');

    const result = decode(inner.toBytes());
    expect(result).not.toBeNull();
    expect(result?.kind).toBe('PlayerObjectSharedDelta');

    const data = result?.data as Partial<PlayerObjectSharedBaseline>;
    expect(data.skillTitle).toBe('master_brawler');
    // All other fields must be absent
    expect(Object.keys(data)).toEqual(['skillTitle']);
  });

  it('decodes a multi-field delta (playedTime + showHelmet + lifetimeGcwPoints)', () => {
    const inner = new ByteStream();
    inner.writeU16(3);
    // fieldIndex 9 = playedTime (u32)
    inner.writeU16(9);
    inner.writeU32(123_456_789);
    // fieldIndex 14 = lifetimeGcwPoints (i64)
    inner.writeU16(14);
    inner.writeI64(9_007_199_254_740_993n); // > 2^53
    // fieldIndex 19 = showHelmet (bool)
    inner.writeU16(19);
    inner.writeBool(true);

    const result = decode(inner.toBytes());
    expect(result).not.toBeNull();
    const data = result?.data as Partial<PlayerObjectSharedBaseline>;
    expect(data.playedTime).toBe(123_456_789);
    expect(data.lifetimeGcwPoints).toBe(9_007_199_254_740_993n);
    expect(data.showHelmet).toBe(true);
    expect('showBackpack' in data).toBe(false);
    expect('skillTitle' in data).toBe(false);
  });

  it('decodes custom-codec fields (objectName + BitArray collections at index 16)', () => {
    const collectionsBytes = new Uint8Array([0x01, 0xff, 0x10, 0x00]);
    const inner = new ByteStream();
    inner.writeU16(2);
    // fieldIndex 2 = objectName (UnicodeString — variable length)
    inner.writeU16(2);
    writeUnicodeString(inner, 'Hero of Tatooine');
    // fieldIndex 16 = collections (BitArray = [i32 nBytes][i32 nBits][bytes])
    inner.writeU16(16);
    inner.writeI32(collectionsBytes.length);
    inner.writeI32(32);
    inner.writeBytes(collectionsBytes);

    const result = decode(inner.toBytes());
    expect(result).not.toBeNull();
    const data = result?.data as Partial<PlayerObjectSharedBaseline> & {
      collections?: BitArrayValue;
    };
    expect(data.objectName).toBe('Hero of Tatooine');
    expect(data.collections?.numInUseBits).toBe(32);
    expect([...(data.collections?.bytes ?? [])]).toEqual([0x01, 0xff, 0x10, 0x00]);
  });

  it('returns null on out-of-range fieldIndex (swallows throw)', () => {
    const inner = new ByteStream();
    inner.writeU16(1);
    inner.writeU16(99); // package only has 20 fields (0-19)
    inner.writeI32(0);

    const result = decode(inner.toBytes());
    expect(result).toBeNull();
  });

  it('is findable via deltaRegistry.get(PLAY, SHARED)', () => {
    const d = deltaRegistry.get(ObjectTypeTags.PLAY, BaselinePackageIds.SHARED);
    expect(d).toBe(PlayerObjectSharedDeltaDecoder);
  });
});
