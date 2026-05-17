import { describe, expect, it } from 'vitest';

import { ByteStream } from '../../../archive/byte-stream.js';
import { NetworkIdCodec } from '../../../archive/network-id.js';
import { ReadIterator } from '../../../archive/read-iterator.js';
import { writeStdString } from '../../../archive/string.js';
import { tryDecodeDelta } from './delta-registry.js';
import type {
  GcwDefenderRegion,
  PlayerObjectSharedNpBaseline,
} from './player-object-baseline-6.js';
import { BaselinePackageIds, ObjectTypeTags } from './registry.js';
import { StringIdCodec } from './string-id.js';

// Side-effect: ensure the PLAY/SHARED_NP delta decoder is registered.
import './player-object-delta-6.js';

const TYPE_ID = ObjectTypeTags.PLAY;
const PACKAGE_ID = BaselinePackageIds.SHARED_NP;

function decode(payload: Uint8Array) {
  return tryDecodeDelta(TYPE_ID, PACKAGE_ID, payload, (b) => new ReadIterator(b));
}

describe('PlayerObjectSharedNpDelta', () => {
  it('decodes a single-field delta (currentGcwRank only)', () => {
    const inner = new ByteStream();
    inner.writeU16(1); // count
    inner.writeU16(3); // fieldIndex 3 = currentGcwRank
    inner.writeI32(14);

    const result = decode(inner.toBytes());
    expect(result).not.toBeNull();
    expect(result?.kind).toBe('PlayerObjectSharedNpDelta');

    const data = result?.data as Partial<PlayerObjectSharedNpBaseline>;
    expect(data.currentGcwRank).toBe(14);
    // All other fields must be absent (sparse).
    expect(Object.keys(data)).toEqual(['currentGcwRank']);
  });

  it('decodes a multi-field delta (squelch state change: squelchedById + squelchedByName + squelchExpireTime)', () => {
    const inner = new ByteStream();
    inner.writeU16(3);
    // fieldIndex 12 = squelchedById
    inner.writeU16(12);
    NetworkIdCodec.encode(inner, 0x4242424242424242n);
    // fieldIndex 13 = squelchedByName
    inner.writeU16(13);
    writeStdString(inner, 'AdminGuy');
    // fieldIndex 14 = squelchExpireTime
    inner.writeU16(14);
    inner.writeI32(-1);

    const result = decode(inner.toBytes());
    expect(result).not.toBeNull();
    const data = result?.data as Partial<PlayerObjectSharedNpBaseline>;
    expect(data.squelchedById).toBe(0x4242424242424242n);
    expect(data.squelchedByName).toBe('AdminGuy');
    expect(data.squelchExpireTime).toBe(-1);
    expect('currentGcwRank' in data).toBe(false);
    expect('environmentFlags' in data).toBe(false);
  });

  it('decodes a StringId delta (descriptionStringId)', () => {
    const inner = new ByteStream();
    inner.writeU16(1);
    inner.writeU16(1); // fieldIndex 1 = descriptionStringId
    StringIdCodec.encode(inner, { table: 'player_n', textIndex: 7, text: 'jedi_knight' });

    const result = decode(inner.toBytes());
    expect(result).not.toBeNull();
    const data = result?.data as Partial<PlayerObjectSharedNpBaseline>;
    expect(data.descriptionStringId).toEqual({
      table: 'player_n',
      textIndex: 7,
      text: 'jedi_knight',
    });
  });

  it('decodes a GcwDefenderRegion composite field (cityGcwDefenderRegion)', () => {
    const inner = new ByteStream();
    inner.writeU16(1);
    inner.writeU16(10); // fieldIndex 10 = cityGcwDefenderRegion
    // GcwDefenderRegion wire layout: [std::string region][bool qualifiesForBonus][bool qualifiesForTitle]
    writeStdString(inner, 'tatooine_dune_sea');
    inner.writeBool(true);
    inner.writeBool(false);

    const result = decode(inner.toBytes());
    expect(result).not.toBeNull();
    const data = result?.data as Partial<PlayerObjectSharedNpBaseline> & {
      cityGcwDefenderRegion?: GcwDefenderRegion;
    };
    expect(data.cityGcwDefenderRegion).toEqual({
      region: 'tatooine_dune_sea',
      qualifiesForBonus: true,
      qualifiesForTitle: false,
    });
  });

  it('decodes a float field (currentGcwRankProgress)', () => {
    const inner = new ByteStream();
    inner.writeU16(1);
    inner.writeU16(4); // fieldIndex 4 = currentGcwRankProgress
    inner.writeF32(0.5);

    const result = decode(inner.toBytes());
    expect(result).not.toBeNull();
    const data = result?.data as Partial<PlayerObjectSharedNpBaseline>;
    expect(data.currentGcwRankProgress).toBeCloseTo(0.5, 5);
  });

  it('returns null on out-of-range fieldIndex (swallows throw)', () => {
    const inner = new ByteStream();
    inner.writeU16(1);
    inner.writeU16(99); // package only has 17 fields (0-16)
    inner.writeI32(0);

    const result = decode(inner.toBytes());
    expect(result).toBeNull();
  });
});
