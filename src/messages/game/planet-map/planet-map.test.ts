/**
 * Golden-byte + round-trip tests for the planetary-map-locations wire
 * messages: the `MapLocation` struct codec, `GetMapLocationsMessage`
 * (client → server), and `GetMapLocationsResponseMessage` (server →
 * client).
 *
 * The literal byte assertions pin the wire layout against the C++
 * `MapLocationArchive.cpp` / `GetMapLocations*Message.cpp` so a struct
 * shape drift fails CI in seconds.
 */

import { describe, expect, it } from 'vitest';

import { ByteStream } from '../../../archive/byte-stream.js';
import { ReadIterator } from '../../../archive/read-iterator.js';
import { encodeMessage, parseHeader } from '../../base.js';
import { messageRegistry } from '../../registry.js';
import {
  GetMapLocationsMessage,
  GetMapLocationsResponseMessage,
  type MapLocation,
  MapLocationCodec,
  MapLocationFlags,
} from './index.js';

// Side-effect imports — register the decoders.
import './index.js';

/** Hex-dump helper for failure messages / readability. */
function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join(' ');
}

describe('MapLocation codec', () => {
  it('encodes the exact wire byte layout (empty name, active flag)', () => {
    const loc: MapLocation = {
      locationId: 0x42n,
      locationName: '',
      x: 10,
      z: -20,
      category: 15, // starport
      subCategory: 0,
      flags: MapLocationFlags.Active, // 0x02
    };
    const stream = new ByteStream();
    MapLocationCodec.encode(stream, loc);
    const bytes = stream.toBytes();

    // locationId i64 LE 0x42        → 42 00 00 00 00 00 00 00  (8)
    // locationName Unicode u32 count 0 → 00 00 00 00            (4)
    // x f32 LE 10.0                 → 00 00 20 41               (4)
    // z f32 LE -20.0                → 00 00 a0 c1               (4)
    // category u8 15                → 0f                        (1)
    // subCategory u8 0              → 00                        (1)
    // flags u8 2                    → 02                        (1)
    // total = 23 bytes
    expect(bytes.length, hex(bytes)).toBe(23);
    expect(Array.from(bytes)).toEqual([
      0x42,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00, // locationId
      0x00,
      0x00,
      0x00,
      0x00, // locationName count
      0x00,
      0x00,
      0x20,
      0x41, // x = 10.0
      0x00,
      0x00,
      0xa0,
      0xc1, // z = -20.0
      0x0f, // category
      0x00, // subCategory
      0x02, // flags
    ]);
  });

  it('round-trips an entry with an @stf StringId name and the inactive flag', () => {
    const loc: MapLocation = {
      locationId: 0x7fffffff_ffffffffn,
      locationName: '@planet_n:mos_eisley',
      x: 3528.5,
      z: -4804.25,
      category: 3, // cantina
      subCategory: 7,
      flags: MapLocationFlags.Inactive, // 0x01
    };
    const stream = new ByteStream();
    MapLocationCodec.encode(stream, loc);
    const decoded = MapLocationCodec.decode(new ReadIterator(stream.toBytes()));
    expect(decoded).toEqual(loc);
  });

  it('round-trips a zero/default entry', () => {
    const loc: MapLocation = {
      locationId: 0n,
      locationName: '',
      x: 0,
      z: 0,
      category: 0,
      subCategory: 0,
      flags: 0,
    };
    const stream = new ByteStream();
    MapLocationCodec.encode(stream, loc);
    const decoded = MapLocationCodec.decode(new ReadIterator(stream.toBytes()));
    expect(decoded).toEqual(loc);
  });
});

describe('GetMapLocationsMessage', () => {
  it('has the right metadata', () => {
    expect(GetMapLocationsMessage.messageName).toBe('GetMapLocationsMessage');
    expect(GetMapLocationsMessage.varCount).toBe(5);
    expect(GetMapLocationsMessage.typeCrc).toBeGreaterThan(0);
  });

  it('has the exact byte layout we expect', () => {
    const msg = new GetMapLocationsMessage('tatooine', 0, 0, 0);
    const bytes = encodeMessage(msg);
    // varCount u16 LE 5            → 05 00            (2)
    // typeCrc u32 LE               → 4 bytes          (4)
    // planetName std::string "tatooine": u16 len 8 → 08 00; 8 ASCII bytes (10)
    // cacheVersionStatic i32 LE 0  → 00 00 00 00      (4)
    // cacheVersionDynamic i32 LE 0 → 00 00 00 00      (4)
    // cacheVersionPersist i32 LE 0 → 00 00 00 00      (4)
    // total = 2 + 4 + 10 + 12 = 28
    expect(bytes.length, hex(bytes)).toBe(28);
    expect(bytes[0]).toBe(0x05);
    expect(bytes[1]).toBe(0x00);
    // planetName length prefix
    expect(bytes[6]).toBe(0x08);
    expect(bytes[7]).toBe(0x00);
    // "tatooine" ASCII
    expect(Buffer.from(bytes.slice(8, 16)).toString('ascii')).toBe('tatooine');
    // three zero version ints
    expect(Array.from(bytes.slice(16, 28))).toEqual(new Array(12).fill(0));
  });

  it('round-trips encode → parseHeader → registry decode', () => {
    const original = new GetMapLocationsMessage('naboo', 7, 11, 13);
    const bytes = encodeMessage(original);

    const { varCount, typeCrc, payload } = parseHeader(bytes);
    expect(varCount).toBe(5);
    expect(typeCrc).toBe(GetMapLocationsMessage.typeCrc);

    const decoder = messageRegistry.getByCrc(typeCrc);
    if (decoder === undefined) throw new Error('GetMapLocationsMessage decoder not registered');
    const decoded = decoder.decodePayload(payload);
    if (!(decoded instanceof GetMapLocationsMessage)) {
      throw new Error('decoded message is not a GetMapLocationsMessage');
    }
    expect(decoded.planetName).toBe('naboo');
    expect(decoded.cacheVersionStatic).toBe(7);
    expect(decoded.cacheVersionDynamic).toBe(11);
    expect(decoded.cacheVersionPersist).toBe(13);
  });
});

describe('GetMapLocationsResponseMessage', () => {
  it('has the right metadata', () => {
    expect(GetMapLocationsResponseMessage.messageName).toBe('GetMapLocationsResponseMessage');
    expect(GetMapLocationsResponseMessage.varCount).toBe(8);
    expect(GetMapLocationsResponseMessage.typeCrc).toBeGreaterThan(0);
  });

  it('encodes empty arrays as a u32 zero count each', () => {
    const msg = new GetMapLocationsResponseMessage('tatooine', [], [], [], 0, 0, 0);
    const bytes = encodeMessage(msg);
    // varCount u16 LE 8           → 08 00              (2)
    // typeCrc u32 LE              → 4 bytes            (4)
    // planetName "tatooine": u16 8 + 8 bytes           (10)
    // 3 × empty AutoArray<MapLocation>: u32 0 each → 00 00 00 00 ×3 (12)
    // 3 × version i32 0: 00 00 00 00 ×3                (12)
    // total = 2 + 4 + 10 + 12 + 12 = 40
    expect(bytes.length, hex(bytes)).toBe(40);
    // The three empty-array counts sit right after the planetName (offset 16).
    expect(Array.from(bytes.slice(16, 28))).toEqual(new Array(12).fill(0));
  });

  it('round-trips a response carrying entries in each of the three arrays', () => {
    const staticLoc: MapLocation = {
      locationId: 0x100n,
      locationName: '@map:starport',
      x: 100.5,
      z: -200.25,
      category: 15,
      subCategory: 0,
      flags: MapLocationFlags.Active,
    };
    const dynamicLoc: MapLocation = {
      locationId: 0x200n,
      locationName: '',
      x: -5,
      z: 5,
      category: 3,
      subCategory: 1,
      flags: 0,
    };
    const persistLoc: MapLocation = {
      locationId: 0x300n,
      locationName: 'Player City',
      x: 2800,
      z: -2800,
      category: 17,
      subCategory: 0,
      flags: MapLocationFlags.Inactive,
    };
    const original = new GetMapLocationsResponseMessage(
      'naboo',
      [staticLoc, staticLoc],
      [dynamicLoc],
      [persistLoc],
      42,
      43,
      44,
    );
    const bytes = encodeMessage(original);

    const { varCount, typeCrc, payload } = parseHeader(bytes);
    expect(varCount).toBe(8);
    expect(typeCrc).toBe(GetMapLocationsResponseMessage.typeCrc);

    const decoder = messageRegistry.getByCrc(typeCrc);
    if (decoder === undefined) {
      throw new Error('GetMapLocationsResponseMessage decoder not registered');
    }
    const decoded = decoder.decodePayload(payload);
    if (!(decoded instanceof GetMapLocationsResponseMessage)) {
      throw new Error('decoded message is not a GetMapLocationsResponseMessage');
    }
    expect(decoded.planetName).toBe('naboo');
    expect(decoded.mapLocationsStatic).toEqual([staticLoc, staticLoc]);
    expect(decoded.mapLocationsDynamic).toEqual([dynamicLoc]);
    expect(decoded.mapLocationsPersist).toEqual([persistLoc]);
    expect(decoded.versionStatic).toBe(42);
    expect(decoded.versionDynamic).toBe(43);
    expect(decoded.versionPersist).toBe(44);
  });
});
