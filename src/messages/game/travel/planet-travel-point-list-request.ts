/**
 * PlanetTravelPointListRequest — client → server. Asks the server for the
 * full set of travel points available on `planetName`. The server replies
 * with `PlanetTravelPointListResponse`.
 *
 * The client typically sends this for each planet it wants to populate in
 * the ticket-purchase UI's destination list (i.e. each planet returned by
 * the `EnterTicketPurchaseModeMessage`'s home-planet plus any others the
 * client knows are reachable).
 *
 * Wire layout (addVariable order, 2 vars on the wire — the source has a
 * commented-out `m_sequenceId` that is NOT serialized):
 *   [NetworkId u64]  m_networkId    — player's NetworkId (echoes who asked)
 *   [std::string]    m_planetName   — planet stem (e.g. "tatooine")
 *
 * Source:
 *   ~/code/swg-main/src/engine/shared/library/sharedNetworkMessages/src/
 *     shared/clientGameServer/PlanetTravelPointListRequest.{h,cpp}
 */

import type { IByteStream, IReadIterator } from '../../../archive/interface.js';
import { NetworkIdCodec } from '../../../archive/network-id.js';
import { readStdString, writeStdString } from '../../../archive/string.js';
import type { NetworkId } from '../../../types.js';
import { GameNetworkMessage, asDecoder, defineMessageMeta } from '../../base.js';
import { registerMessage } from '../../registry.js';

const META = defineMessageMeta('PlanetTravelPointListRequest');

export class PlanetTravelPointListRequest extends GameNetworkMessage {
  static override readonly messageName = META.messageName;
  static readonly typeCrc = META.typeCrc;
  /** cmd + networkId + planetName (sequenceId NOT serialized — see source) */
  static override readonly varCount = 3;

  constructor(
    public readonly networkId: NetworkId,
    public readonly planetName: string,
  ) {
    super();
  }

  encodePayload(stream: IByteStream): void {
    NetworkIdCodec.encode(stream, this.networkId);
    writeStdString(stream, this.planetName);
  }

  static decodePayload(iter: IReadIterator): PlanetTravelPointListRequest {
    const networkId = NetworkIdCodec.decode(iter);
    const planetName = readStdString(iter);
    return new PlanetTravelPointListRequest(networkId, planetName);
  }
}

export const PlanetTravelPointListRequestDecoder = registerMessage(
  asDecoder(PlanetTravelPointListRequest),
);
