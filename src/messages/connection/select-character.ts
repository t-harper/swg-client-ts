/**
 * SelectCharacter — client-to-server; tell the ConnectionServer which
 * character (from `EnumerateCharacterId`) we want to play. Triggers
 * validation, then the routing message back to a GameServer.
 *
 * Wire layout:
 *   [NetworkId (u64)] m_id
 *
 * Source:
 *   /home/tharper/code/swg-main/src/engine/shared/library/sharedNetworkMessages/src/shared/clientGameServer/ClientCentralMessages.{h,cpp}
 */

import type { NetworkId } from '../../types.js';
import {
  GameNetworkMessage,
  constcrc,
  registerMessage,
  type IByteStream,
  type IReadIterator,
} from '../_stub-base.js';
import { readNetworkId, writeNetworkId } from '../../archive/_stub-byte-stream.js';

export class SelectCharacter extends GameNetworkMessage {
  static override readonly messageName = 'SelectCharacter';
  static readonly typeCrc = constcrc(SelectCharacter.messageName);

  constructor(public readonly networkId: NetworkId) {
    super();
  }

  encodePayload(stream: IByteStream): void {
    writeNetworkId(stream, this.networkId);
  }

  static decodePayload(iter: IReadIterator): SelectCharacter {
    return new SelectCharacter(readNetworkId(iter));
  }
}

registerMessage(SelectCharacter);
