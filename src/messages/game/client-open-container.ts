/**
 * ClientOpenContainerMessage — client → server. Asks the server to open a
 * container UI (inventory, bank, datapad, lootable corpse, etc.). For the
 * player's own inventory the convention is containerId = playerNetworkId
 * and slot = "inventory".
 *
 * There is no wire-level "close" message; opening a different container or
 * moving away is interpreted as a close by the server.
 *
 * Wire layout (addVariable order):
 *   [NetworkId (u64)] m_containerId
 *   [std::string]     m_slot
 *
 * Source:
 *   /home/tharper/code/swg-main/src/engine/shared/library/sharedNetworkMessages/src/shared/clientGameServer/ClientOpenContainerMessage.{h,cpp}
 */

import type { IByteStream, IReadIterator } from '../../archive/interface.js';
import { NetworkIdCodec } from '../../archive/network-id.js';
import { readStdString, writeStdString } from '../../archive/string.js';
import type { NetworkId } from '../../types.js';
import { GameNetworkMessage, asDecoder, defineMessageMeta } from '../base.js';
import { registerMessage } from '../registry.js';

const META = defineMessageMeta('ClientOpenContainerMessage');

export class ClientOpenContainerMessage extends GameNetworkMessage {
  static override readonly messageName = META.messageName;
  static readonly typeCrc = META.typeCrc;
  /** cmd + containerId + slot */
  static override readonly varCount = 3;

  constructor(
    public readonly containerId: NetworkId,
    public readonly slot: string,
  ) {
    super();
  }

  encodePayload(stream: IByteStream): void {
    NetworkIdCodec.encode(stream, this.containerId);
    writeStdString(stream, this.slot);
  }

  static decodePayload(iter: IReadIterator): ClientOpenContainerMessage {
    const containerId = NetworkIdCodec.decode(iter);
    const slot = readStdString(iter);
    return new ClientOpenContainerMessage(containerId, slot);
  }
}

export const ClientOpenContainerMessageDecoder = registerMessage(
  asDecoder(ClientOpenContainerMessage),
);
