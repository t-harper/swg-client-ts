/**
 * AddItemMessage — bidirectional (client → server when offering; server → client
 * when echoing the counter-party's offer).
 *
 * Adds a single tangible item to the sender's side of the trade window. The
 * server validates that the item is in the sender's inventory, then echoes
 * the message to the other party's client. May be followed by
 * `AddItemFailedMessage` on rejection (item bound, no-trade flag, etc.).
 *
 * Wire layout (single AutoVariable):
 *   [NetworkId (i64)] object
 *
 * Source:
 *   /home/tharper/code/swg-main/src/engine/shared/library/sharedNetworkMessages/src/shared/clientGameServer/SecureTradeMessages.{h,cpp}
 */

import type { IByteStream, IReadIterator } from '../../../archive/interface.js';
import { NetworkIdCodec } from '../../../archive/network-id.js';
import type { NetworkId } from '../../../types.js';
import { GameNetworkMessage, asDecoder, defineMessageMeta } from '../../base.js';
import { registerMessage } from '../../registry.js';

const META = defineMessageMeta('AddItemMessage');

export class AddItemMessage extends GameNetworkMessage {
  static override readonly messageName = META.messageName;
  static readonly typeCrc = META.typeCrc;
  /** cmd + object */
  static override readonly varCount = 2;

  constructor(public readonly object: NetworkId) {
    super();
  }

  encodePayload(stream: IByteStream): void {
    NetworkIdCodec.encode(stream, this.object);
  }

  static decodePayload(iter: IReadIterator): AddItemMessage {
    return new AddItemMessage(NetworkIdCodec.decode(iter));
  }
}

export const AddItemMessageDecoder = registerMessage(asDecoder(AddItemMessage));
