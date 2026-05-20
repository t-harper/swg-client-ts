/**
 * MapLocation — one entry in the server's planetary-map-locations system.
 *
 * Not a `GameNetworkMessage`; it is a serializable struct that appears
 * inside `GetMapLocationsResponseMessage`'s three `AutoArray<MapLocation>`
 * fields. This module exports `MapLocationCodec` (an `ICodec<MapLocation>`)
 * so `AutoArrayCodec(MapLocationCodec)` composes cleanly.
 *
 * Wire layout (the C++ `Archive::get/put` order — note this is NOT the
 * struct's field-declaration order; `m_size` is declared but is NOT on
 * the wire):
 *   [NetworkId i64]       m_locationId
 *   [Unicode::String]     m_locationName   (u32 char-count + UTF-16 LE)
 *   [f32]                 m_location.x     (Vector2d.x — world X)
 *   [f32]                 m_location.y     (Vector2d.y — world Z, planet-map
 *                                           is top-down so the wire "y" is
 *                                           the world-Z plane)
 *   [u8]                  m_category
 *   [u8]                  m_subCategory
 *   [u8]                  m_flags          (0x01 inactive, 0x02 active)
 *
 * Source:
 *   ~/code/swg-main/src/engine/shared/library/sharedNetworkMessages/src/
 *     shared/clientGameServer/MapLocationArchive.cpp   (wire order)
 *     shared/clientGameServer/MapLocation.h            (Flags enum, fields)
 */

import type { IByteStream, ICodec, IReadIterator } from '../../../archive/interface.js';
import { NetworkIdCodec } from '../../../archive/network-id.js';
import { readUnicodeString, writeUnicodeString } from '../../../archive/unicode-string.js';
import type { NetworkId } from '../../../types.js';

/** `MapLocation::Flags` — `m_flags` bitfield values. */
export const MapLocationFlags = {
  /** `F_inactive` — the location is currently inactive / not shown. */
  Inactive: 0x01,
  /** `F_active` — the location is explicitly marked active. */
  Active: 0x02,
} as const;

/** One registered planetary-map location. */
export interface MapLocation {
  /** NetworkId of the location object (a `NetworkId`, i64 on the wire). */
  locationId: NetworkId;
  /**
   * Display name. Frequently empty or a raw `@file:key` StringId — the
   * planet-map system leaves STF resolution to the client UI.
   */
  locationName: string;
  /** World X coordinate. */
  x: number;
  /**
   * World Z coordinate. The C++ struct stores this in `Vector2d.y` because
   * the planetary map is a top-down 2D projection; on a 3D position it is
   * the world-Z axis.
   */
  z: number;
  /** Category byte — indexes `datatables/player/planet_map_cat.tab`. */
  category: number;
  /** Sub-category byte — a finer-grained classification in the same table. */
  subCategory: number;
  /** Flags bitfield — see `MapLocationFlags`. */
  flags: number;
}

/**
 * `ICodec<MapLocation>` matching `MapLocationArchive.cpp`'s `get`/`put`.
 * Pass to `AutoArrayCodec(MapLocationCodec)` for the response message's
 * `AutoArray<MapLocation>` fields.
 */
export const MapLocationCodec: ICodec<MapLocation> = {
  encode(stream: IByteStream, value: MapLocation): void {
    NetworkIdCodec.encode(stream, value.locationId);
    writeUnicodeString(stream, value.locationName);
    stream.writeF32(value.x);
    stream.writeF32(value.z);
    stream.writeU8(value.category);
    stream.writeU8(value.subCategory);
    stream.writeU8(value.flags);
  },
  decode(iter: IReadIterator): MapLocation {
    const locationId = NetworkIdCodec.decode(iter);
    const locationName = readUnicodeString(iter);
    const x = iter.readF32();
    const z = iter.readF32();
    const category = iter.readU8();
    const subCategory = iter.readU8();
    const flags = iter.readU8();
    return { locationId, locationName, x, z, category, subCategory, flags };
  },
};
