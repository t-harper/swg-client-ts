/**
 * IsVendorOwnerResponseMessage — server-to-client. Reply to
 * `IsVendorOwnerMessage`. `ownerResult` is a `VendorOwnerResult` value
 * (IsOwner / IsNotOwner / HasNoOwner); `result` is an `AuctionResult`.
 *
 * Wire layout (addVariable order from IsVendorOwnerResponseMessage.cpp:32-36):
 *   [i32]         ownerResult
 *   [i32]         result
 *   [NetworkId]   containerId
 *   [std::string] marketName
 *   [u16]         maxPageSize
 *
 * Source:
 *   /home/tharper/code/swg-main/src/engine/shared/library/sharedNetworkMessages/src/shared/clientGameServer/IsVendorOwnerResponseMessage.{h,cpp}
 */

import type { IByteStream, IReadIterator } from '../../../archive/interface.js';
import { NetworkIdCodec } from '../../../archive/network-id.js';
import { readStdString, writeStdString } from '../../../archive/string.js';
import type { NetworkId } from '../../../types.js';
import { GameNetworkMessage, asDecoder, defineMessageMeta } from '../../base.js';
import { registerMessage } from '../../registry.js';

const META = defineMessageMeta('IsVendorOwnerResponseMessage');

export class IsVendorOwnerResponseMessage extends GameNetworkMessage {
  static override readonly messageName = META.messageName;
  static readonly typeCrc = META.typeCrc;
  /** cmd + ownerResult + result + containerId + marketName + maxPageSize */
  static override readonly varCount = 6;

  constructor(
    public readonly ownerResult: number,
    public readonly result: number,
    public readonly containerId: NetworkId,
    public readonly marketName: string,
    public readonly maxPageSize: number,
  ) {
    super();
  }

  encodePayload(stream: IByteStream): void {
    stream.writeI32(this.ownerResult);
    stream.writeI32(this.result);
    NetworkIdCodec.encode(stream, this.containerId);
    writeStdString(stream, this.marketName);
    stream.writeU16(this.maxPageSize);
  }

  static decodePayload(iter: IReadIterator): IsVendorOwnerResponseMessage {
    const ownerResult = iter.readI32();
    const result = iter.readI32();
    const containerId = NetworkIdCodec.decode(iter);
    const marketName = readStdString(iter);
    const maxPageSize = iter.readU16();
    return new IsVendorOwnerResponseMessage(
      ownerResult,
      result,
      containerId,
      marketName,
      maxPageSize,
    );
  }
}

export const IsVendorOwnerResponseMessageDecoder = registerMessage(
  asDecoder(IsVendorOwnerResponseMessage),
);
