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

import type { IByteStream, IReadIterator } from '../../archive/interface.js';
import { NetworkIdCodec } from '../../archive/network-id.js';
import type { NetworkId } from '../../types.js';
import { GameNetworkMessage, asDecoder, defineMessageMeta } from '../base.js';
import { registerMessage } from '../registry.js';

const META = defineMessageMeta('SelectCharacter');

export class SelectCharacter extends GameNetworkMessage {
  static override readonly messageName = META.messageName;
  static readonly typeCrc = META.typeCrc;
  /** cmd + id */
  static override readonly varCount = 2;

  constructor(public readonly networkId: NetworkId) {
    super();
  }

  encodePayload(stream: IByteStream): void {
    NetworkIdCodec.encode(stream, this.networkId);
  }

  static decodePayload(iter: IReadIterator): SelectCharacter {
    return new SelectCharacter(NetworkIdCodec.decode(iter));
  }
}

export const SelectCharacterDecoder = registerMessage(asDecoder(SelectCharacter));
