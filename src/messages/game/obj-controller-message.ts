/**
 * ObjControllerMessage — server-to-client. The fat workhorse of gameplay
 * traffic (movement, action queues, attribute updates, etc.). The MVP
 * deliberately does NOT model the variable-length data trailer.
 *
 * Wire layout (addVariable order):
 *   [u32]              flags
 *   [i32]              message      (the controller-message subtype)
 *   [NetworkId (u64)]  networkId
 *   [f32]              value
 *   [...]              variable-length data (skipped by `decodePayload`)
 *
 * We parse the fixed 20-byte header so callers can route by `message`
 * subtype if they want, then consume the remainder of the buffer so the
 * multipacket framing stays in sync.
 *
 * Source:
 *   /home/tharper/code/swg-main/src/engine/shared/library/sharedNetworkMessages/src/shared/clientGameServer/ObjectChannelMessages.{h,cpp}
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

export class ObjControllerMessage extends GameNetworkMessage {
  static override readonly messageName = 'ObjControllerMessage';
  static readonly typeCrc = constcrc(ObjControllerMessage.messageName);

  constructor(
    public readonly flags: number,
    public readonly message: number,
    public readonly networkId: NetworkId,
    public readonly value: number,
    /**
     * The unparsed variable-length data trailer. Captured verbatim so
     * a future implementation can route on `message` and decode it.
     */
    public readonly data: Uint8Array = new Uint8Array(0),
  ) {
    super();
  }

  encodePayload(stream: IByteStream): void {
    stream.writeU32(this.flags);
    stream.writeI32(this.message);
    writeNetworkId(stream, this.networkId);
    stream.writeF32(this.value);
    stream.writeBytes(this.data);
  }

  /**
   * Parses the 20-byte header, then captures whatever bytes remain in the
   * iterator as the opaque `data` trailer. The caller is responsible for
   * giving us an iterator scoped to just this message's payload (this is
   * how the registry/dispatch loop should pass it).
   */
  static decodePayload(iter: IReadIterator): ObjControllerMessage {
    const flags = iter.readU32();
    const message = iter.readI32();
    const networkId = readNetworkId(iter);
    const value = iter.readF32();
    const data = iter.remaining > 0 ? iter.readBytes(iter.remaining) : new Uint8Array(0);
    return new ObjControllerMessage(flags, message, networkId, value, data);
  }
}

registerMessage(ObjControllerMessage);
