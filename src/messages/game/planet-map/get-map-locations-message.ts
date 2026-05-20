/**
 * GetMapLocationsMessage — client → server.
 *
 * Asks the server for every registered planetary-map location on
 * `planetName`. The server replies with `GetMapLocationsResponseMessage`.
 *
 * The three cache-version fields let the client skip a re-send when its
 * cached copy is already current — the server compares them against its
 * live versions and returns an empty array set when they match. Sending
 * `0, 0, 0` always forces the server to return the full set.
 *
 * The server only answers for the planet the requesting player is
 * currently zoned in on (it resolves the planet object from the player's
 * scene); a request for any other planet is silently ignored.
 *
 * Wire layout (addVariable order — `GetMapLocationsMessage.cpp:25-28`):
 *   [std::string]  m_planetName
 *   [i32]          m_cacheVersionStatic
 *   [i32]          m_cacheVersionDynamic
 *   [i32]          m_cacheVersionPersist
 *
 * Source:
 *   ~/code/swg-main/src/engine/shared/library/sharedNetworkMessages/src/
 *     shared/clientGameServer/GetMapLocationsMessage.{h,cpp}
 */

import type { IByteStream, IReadIterator } from '../../../archive/interface.js';
import { readStdString, writeStdString } from '../../../archive/string.js';
import { GameNetworkMessage, asDecoder, defineMessageMeta } from '../../base.js';
import { registerMessage } from '../../registry.js';

const META = defineMessageMeta('GetMapLocationsMessage');

export class GetMapLocationsMessage extends GameNetworkMessage {
  static override readonly messageName = META.messageName;
  static readonly typeCrc = META.typeCrc;
  /** cmd + planetName + 3 cache-version ints */
  static override readonly varCount = 5;

  constructor(
    public readonly planetName: string,
    public readonly cacheVersionStatic: number = 0,
    public readonly cacheVersionDynamic: number = 0,
    public readonly cacheVersionPersist: number = 0,
  ) {
    super();
  }

  encodePayload(stream: IByteStream): void {
    writeStdString(stream, this.planetName);
    stream.writeI32(this.cacheVersionStatic);
    stream.writeI32(this.cacheVersionDynamic);
    stream.writeI32(this.cacheVersionPersist);
  }

  static decodePayload(iter: IReadIterator): GetMapLocationsMessage {
    const planetName = readStdString(iter);
    const cacheVersionStatic = iter.readI32();
    const cacheVersionDynamic = iter.readI32();
    const cacheVersionPersist = iter.readI32();
    return new GetMapLocationsMessage(
      planetName,
      cacheVersionStatic,
      cacheVersionDynamic,
      cacheVersionPersist,
    );
  }
}

export const GetMapLocationsMessageDecoder = registerMessage(asDecoder(GetMapLocationsMessage));
