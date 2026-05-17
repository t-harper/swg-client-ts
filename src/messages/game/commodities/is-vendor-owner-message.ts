/**
 * IsVendorOwnerMessage — client-to-server. Ask the server whether the
 * caller is the owner (or has no owner) of the vendor at `containerId`.
 *
 * Wire layout (addVariable order from IsVendorOwnerMessage.cpp:18):
 *   [NetworkId] containerId
 *
 * Source:
 *   /home/tharper/code/swg-main/src/engine/shared/library/sharedNetworkMessages/src/shared/clientGameServer/IsVendorOwnerMessage.{h,cpp}
 */

import type { IByteStream, IReadIterator } from '../../../archive/interface.js';
import { NetworkIdCodec } from '../../../archive/network-id.js';
import type { NetworkId } from '../../../types.js';
import { GameNetworkMessage, asDecoder, defineMessageMeta } from '../../base.js';
import { registerMessage } from '../../registry.js';

const META = defineMessageMeta('IsVendorOwnerMessage');

export class IsVendorOwnerMessage extends GameNetworkMessage {
  static override readonly messageName = META.messageName;
  static readonly typeCrc = META.typeCrc;
  /** cmd + containerId */
  static override readonly varCount = 2;

  constructor(public readonly containerId: NetworkId) {
    super();
  }

  encodePayload(stream: IByteStream): void {
    NetworkIdCodec.encode(stream, this.containerId);
  }

  static decodePayload(iter: IReadIterator): IsVendorOwnerMessage {
    return new IsVendorOwnerMessage(NetworkIdCodec.decode(iter));
  }
}

export const IsVendorOwnerMessageDecoder = registerMessage(asDecoder(IsVendorOwnerMessage));
