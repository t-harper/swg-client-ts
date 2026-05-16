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

import type { IByteStream, IReadIterator } from '../../archive/interface.js';
import { NetworkIdCodec } from '../../archive/network-id.js';
import type { NetworkId } from '../../types.js';
import { GameNetworkMessage, asDecoder, defineMessageMeta } from '../base.js';
import { registerMessage } from '../registry.js';

const META = defineMessageMeta('ObjControllerMessage');

export class ObjControllerMessage extends GameNetworkMessage {
  static override readonly messageName = META.messageName;
  static readonly typeCrc = META.typeCrc;
  /**
   * cmd + flags + message + networkId + value.
   *
   * NOTE: The variable-length `data` trailer is NOT an AutoVariable — it's
   * packed by `ObjControllerMessage::pack` AFTER the GameNetworkMessage::pack
   * call writes the AutoByteStream prefix. So varCount stays 5; the trailing
   * bytes are an out-of-band addition that follows the AutoByteStream-framed
   * payload.
   */
  static override readonly varCount = 5;

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
    NetworkIdCodec.encode(stream, this.networkId);
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
    const networkId = NetworkIdCodec.decode(iter);
    const value = iter.readF32();
    const data = iter.remaining > 0 ? iter.readBytes(iter.remaining) : new Uint8Array(0);
    return new ObjControllerMessage(flags, message, networkId, value, data);
  }
}

export const ObjControllerMessageDecoder = registerMessage(asDecoder(ObjControllerMessage));
