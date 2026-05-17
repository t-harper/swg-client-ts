/**
 * RemoveItemMessage — bidirectional.
 *
 * Removes an item previously added via `AddItemMessage` from the trade
 * window (the user clicked "X" or dragged the item back to their inventory).
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

const META = defineMessageMeta('RemoveItemMessage');

export class RemoveItemMessage extends GameNetworkMessage {
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

  static decodePayload(iter: IReadIterator): RemoveItemMessage {
    return new RemoveItemMessage(NetworkIdCodec.decode(iter));
  }
}

export const RemoveItemMessageDecoder = registerMessage(asDecoder(RemoveItemMessage));
