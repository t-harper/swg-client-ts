/**
 * ClientCreateCharacterSuccess — server-to-client; the character was
 * created and is ready to be selected. Carries the new character's
 * persistent NetworkId.
 *
 * Wire layout:
 *   [NetworkId (u64)] m_networkId
 *
 * Source:
 *   /home/tharper/code/swg-main/src/engine/shared/library/sharedNetworkMessages/src/shared/clientGameServer/ClientCentralMessages.{h,cpp}
 */

import type { IByteStream, IReadIterator } from '../../archive/interface.js';
import { NetworkIdCodec } from '../../archive/network-id.js';
import type { NetworkId } from '../../types.js';
import { GameNetworkMessage, asDecoder, defineMessageMeta } from '../base.js';
import { registerMessage } from '../registry.js';

const META = defineMessageMeta('ClientCreateCharacterSuccess');

export class ClientCreateCharacterSuccess extends GameNetworkMessage {
  static override readonly messageName = META.messageName;
  static readonly typeCrc = META.typeCrc;
  /** cmd + networkId */
  static override readonly varCount = 2;

  constructor(public readonly networkId: NetworkId) {
    super();
  }

  encodePayload(stream: IByteStream): void {
    NetworkIdCodec.encode(stream, this.networkId);
  }

  static decodePayload(iter: IReadIterator): ClientCreateCharacterSuccess {
    return new ClientCreateCharacterSuccess(NetworkIdCodec.decode(iter));
  }
}

export const ClientCreateCharacterSuccessDecoder = registerMessage(
  asDecoder(ClientCreateCharacterSuccess),
);
