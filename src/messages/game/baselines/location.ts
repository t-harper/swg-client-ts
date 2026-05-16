/**
 * Location and Waypoint codecs — used by baseline packages whose member set
 * includes `AutoDeltaVariable<Location>` or `AutoDeltaVariable<Waypoint>`.
 *
 * Both types are simple field aggregates whose `Archive::put` writes each
 * field in sequence with no length prefix — the receiver reads in the same
 * order.
 *
 * Location wire layout (matches `LocationArchive.cpp::put` lines 27-32):
 *   [Vector (3 f32 LE)]  coordinates
 *   [NetworkId (i64 LE)] cell           (`NetworkId::cms_invalid` (== 0) for open-world)
 *   [u32 LE]             sceneIdCrc     (the planet CRC; 0 for "no scene")
 *
 * Waypoint wire layout (matches `Waypoint.cpp::put` lines 133-141):
 *   [u32 LE]             appearanceNameCrc
 *   [Location]           location
 *   [Unicode::String]    name
 *   [NetworkId (i64 LE)] networkId
 *   [u8]                 color          (see `WaypointColor` enum)
 *   [bool (u8)]          active
 *
 * Source:
 *   /home/tharper/code/swg-main/src/engine/shared/library/sharedUtility/src/shared/Location.{h,cpp}
 *   /home/tharper/code/swg-main/src/engine/shared/library/sharedUtility/src/shared/LocationArchive.cpp
 *   /home/tharper/code/swg-main/src/engine/shared/library/sharedGame/src/shared/object/Waypoint.{h,cpp}
 */

import type { IByteStream, ICodec, IReadIterator } from '../../../archive/interface.js';
import { NetworkIdCodec } from '../../../archive/network-id.js';
import { Vector3Codec } from '../../../archive/transform.js';
import { readUnicodeString, writeUnicodeString } from '../../../archive/unicode-string.js';
import type { NetworkId, Vector3 } from '../../../types.js';

export interface LocationValue {
  coordinates: Vector3;
  /** NetworkId of the containing cell; `0n` for open-world (not inside a building). */
  cell: NetworkId;
  /** CRC of the scene name (planet name). */
  sceneIdCrc: number;
}

export const EMPTY_LOCATION: LocationValue = {
  coordinates: { x: 0, y: 0, z: 0 },
  cell: 0n,
  sceneIdCrc: 0,
};

export const LocationCodec: ICodec<LocationValue> = {
  encode(stream: IByteStream, value: LocationValue): void {
    Vector3Codec.encode(stream, value.coordinates);
    NetworkIdCodec.encode(stream, value.cell);
    stream.writeU32(value.sceneIdCrc);
  },
  decode(iter: IReadIterator): LocationValue {
    const coordinates = Vector3Codec.decode(iter);
    const cell = NetworkIdCodec.decode(iter);
    const sceneIdCrc = iter.readU32();
    return { coordinates, cell, sceneIdCrc };
  },
};

/**
 * Waypoint color enum (from `Waypoint::enum` in Waypoint.h:31-44).
 * Stored as `uint8`.
 */
export const WaypointColor = {
  Invisible: 0,
  Blue: 1,
  Green: 2,
  Orange: 3,
  Yellow: 4,
  Purple: 5,
  White: 6,
  Space: 7,
  Small: 8,
  Entrance: 9,
} as const;

export interface WaypointValue {
  /** CRC of the waypoint's appearance template name. 0 for the default. */
  appearanceNameCrc: number;
  location: LocationValue;
  /** Display name (Unicode — UTF-16 LE on the wire). */
  name: string;
  /** The waypoint's own NetworkId (server tracks waypoints as data objects). */
  networkId: NetworkId;
  /** One of `WaypointColor`. */
  color: number;
  /** True if the player has enabled the waypoint. */
  active: boolean;
}

export const EMPTY_WAYPOINT: WaypointValue = {
  appearanceNameCrc: 0,
  location: EMPTY_LOCATION,
  name: '',
  networkId: 0n,
  color: WaypointColor.Invisible,
  active: false,
};

export const WaypointCodec: ICodec<WaypointValue> = {
  encode(stream: IByteStream, value: WaypointValue): void {
    stream.writeU32(value.appearanceNameCrc);
    LocationCodec.encode(stream, value.location);
    writeUnicodeString(stream, value.name);
    NetworkIdCodec.encode(stream, value.networkId);
    stream.writeU8(value.color);
    stream.writeBool(value.active);
  },
  decode(iter: IReadIterator): WaypointValue {
    const appearanceNameCrc = iter.readU32();
    const location = LocationCodec.decode(iter);
    const name = readUnicodeString(iter);
    const networkId = NetworkIdCodec.decode(iter);
    const color = iter.readU8();
    const active = iter.readBool();
    return { appearanceNameCrc, location, name, networkId, color, active };
  },
};
