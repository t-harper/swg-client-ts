/**
 * GetMapLocationsResponseMessage — server → client.
 *
 * The reply to `GetMapLocationsMessage`. Carries every registered
 * planetary-map location, split into three arrays by lifetime:
 *   - `static`  — fixed world fixtures (starports, cantinas, banks, …);
 *                 this is where the categories `ctx.map` cares about live.
 *   - `dynamic` — short-lived runtime locations.
 *   - `persist` — player-created persistent locations (e.g. player cities).
 *
 * Each entry's `category` byte disambiguates regardless of which array it
 * arrived in, so consumers should merge all three and filter by category.
 *
 * The three version ints echo the server's current cache versions; a
 * client may store them and pass them back on a later `GetMapLocationsMessage`
 * to let the server skip re-sending an unchanged set.
 *
 * Wire layout (addVariable order — `GetMapLocationsResponseMessage.cpp:38-44`):
 *   [std::string]            m_planetName
 *   [AutoArray<MapLocation>] m_mapLocationsStatic
 *   [AutoArray<MapLocation>] m_mapLocationsDynamic
 *   [AutoArray<MapLocation>] m_mapLocationsPersist
 *   [i32]                    m_versionStatic
 *   [i32]                    m_versionDynamic
 *   [i32]                    m_versionPersist
 *
 * Each `AutoArray<MapLocation>` is `[u32 LE count][count × MapLocation]`.
 *
 * Source:
 *   ~/code/swg-main/src/engine/shared/library/sharedNetworkMessages/src/
 *     shared/clientGameServer/GetMapLocationsResponseMessage.{h,cpp}
 */

import { AutoArrayCodec } from '../../../archive/containers.js';
import type { IByteStream, IReadIterator } from '../../../archive/interface.js';
import { readStdString, writeStdString } from '../../../archive/string.js';
import { GameNetworkMessage, asDecoder, defineMessageMeta } from '../../base.js';
import { registerMessage } from '../../registry.js';
import { type MapLocation, MapLocationCodec } from './map-location.js';

const META = defineMessageMeta('GetMapLocationsResponseMessage');

/** `AutoArray<MapLocation>` codec — `[u32 count][MapLocation × count]`. */
const MapLocationArrayCodec = AutoArrayCodec(MapLocationCodec);

export class GetMapLocationsResponseMessage extends GameNetworkMessage {
  static override readonly messageName = META.messageName;
  static readonly typeCrc = META.typeCrc;
  /** cmd + planetName + 3 location arrays + 3 version ints */
  static override readonly varCount = 8;

  constructor(
    public readonly planetName: string,
    public readonly mapLocationsStatic: MapLocation[],
    public readonly mapLocationsDynamic: MapLocation[],
    public readonly mapLocationsPersist: MapLocation[],
    public readonly versionStatic: number,
    public readonly versionDynamic: number,
    public readonly versionPersist: number,
  ) {
    super();
  }

  encodePayload(stream: IByteStream): void {
    writeStdString(stream, this.planetName);
    MapLocationArrayCodec.encode(stream, this.mapLocationsStatic);
    MapLocationArrayCodec.encode(stream, this.mapLocationsDynamic);
    MapLocationArrayCodec.encode(stream, this.mapLocationsPersist);
    stream.writeI32(this.versionStatic);
    stream.writeI32(this.versionDynamic);
    stream.writeI32(this.versionPersist);
  }

  static decodePayload(iter: IReadIterator): GetMapLocationsResponseMessage {
    const planetName = readStdString(iter);
    const mapLocationsStatic = MapLocationArrayCodec.decode(iter);
    const mapLocationsDynamic = MapLocationArrayCodec.decode(iter);
    const mapLocationsPersist = MapLocationArrayCodec.decode(iter);
    const versionStatic = iter.readI32();
    const versionDynamic = iter.readI32();
    const versionPersist = iter.readI32();
    return new GetMapLocationsResponseMessage(
      planetName,
      mapLocationsStatic,
      mapLocationsDynamic,
      mapLocationsPersist,
      versionStatic,
      versionDynamic,
      versionPersist,
    );
  }
}

export const GetMapLocationsResponseMessageDecoder = registerMessage(
  asDecoder(GetMapLocationsResponseMessage),
);
