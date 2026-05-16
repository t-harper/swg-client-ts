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

import { readNetworkId, writeNetworkId } from '../../archive/_stub-byte-stream.js';
import type { NetworkId } from '../../types.js';
import {
  GameNetworkMessage,
  type IByteStream,
  type IReadIterator,
  constcrc,
  registerMessage,
} from '../_stub-base.js';

export class ClientCreateCharacterSuccess extends GameNetworkMessage {
  static override readonly messageName = 'ClientCreateCharacterSuccess';
  static readonly typeCrc = constcrc(ClientCreateCharacterSuccess.messageName);

  constructor(public readonly networkId: NetworkId) {
    super();
  }

  encodePayload(stream: IByteStream): void {
    writeNetworkId(stream, this.networkId);
  }

  static decodePayload(iter: IReadIterator): ClientCreateCharacterSuccess {
    return new ClientCreateCharacterSuccess(readNetworkId(iter));
  }
}

registerMessage(ClientCreateCharacterSuccess);
