/**
 * ObjControllerMessage — server-to-client. The fat workhorse of gameplay
 * traffic (movement, action queues, attribute updates, etc.).
 *
 * Wire layout (addVariable order):
 *   [u32]              flags
 *   [i32]              message      (the controller-message subtype = CM_* enum value)
 *   [NetworkId (u64)]  networkId
 *   [f32]              value
 *   [...]              variable-length data (decoded via subtype registry)
 *
 * We parse the fixed 20-byte header, capture the trailer verbatim as
 * `data`, and ALSO try to decode the trailer using the subtype registry
 * (`src/messages/game/obj-controller/registry.ts`). If a decoder is
 * registered for `message`, `decodedSubtype` is `{ kind, data }`. If not
 * (or if decoding throws), `decodedSubtype` is `null` and the diagnostic
 * `subtypeCrcHex` is the lowercase 4-byte hex of `message` for log
 * inspection.
 *
 * Source:
 *   /home/tharper/code/swg-main/src/engine/shared/library/sharedNetworkMessages/src/shared/clientGameServer/ObjectChannelMessages.{h,cpp}
 */

import type { IByteStream, IReadIterator } from '../../archive/interface.js';
import { NetworkIdCodec } from '../../archive/network-id.js';
import { ReadIterator } from '../../archive/read-iterator.js';
import type { NetworkId } from '../../types.js';
import { GameNetworkMessage, asDecoder, defineMessageMeta } from '../base.js';
import { registerMessage } from '../registry.js';
import { type DecodedSubtype, tryDecodeSubtype } from './obj-controller/registry.js';

const META = defineMessageMeta('ObjControllerMessage');

/**
 * Render `message` as an unsigned 4-byte hex string. `message` is declared
 * as int32 on the wire but logs treat it like a CRC for grepability.
 */
function hexifyMessage(message: number): string {
  return `0x${(message >>> 0).toString(16).padStart(8, '0')}`;
}

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

  /** Lowercase 4-byte hex of `message` for log inspection. */
  public readonly subtypeCrcHex: string;

  constructor(
    public readonly flags: number,
    public readonly message: number,
    public readonly networkId: NetworkId,
    public readonly value: number,
    /**
     * The unparsed variable-length data trailer. Captured verbatim so
     * subtype decoders can re-parse, callers can hex-dump, and so the
     * `encodePayload` round-trip works even when `decodedSubtype` is null.
     */
    public readonly data: Uint8Array = new Uint8Array(0),
    /**
     * Decoded trailer if a subtype decoder is registered for `message`,
     * otherwise `null`. The shape of `data` is subtype-specific — see
     * `src/messages/game/obj-controller/<kind>.ts`.
     */
    public readonly decodedSubtype: DecodedSubtype | null = null,
  ) {
    super();
    this.subtypeCrcHex = hexifyMessage(message);
  }

  encodePayload(stream: IByteStream): void {
    stream.writeU32(this.flags);
    stream.writeI32(this.message);
    NetworkIdCodec.encode(stream, this.networkId);
    stream.writeF32(this.value);
    stream.writeBytes(this.data);
  }

  /**
   * Parses the 20-byte header, captures the trailer as `data`, then attempts
   * subtype dispatch. The caller is responsible for giving us an iterator
   * scoped to just this message's payload (this is how the registry/dispatch
   * loop should pass it).
   */
  static decodePayload(iter: IReadIterator): ObjControllerMessage {
    const flags = iter.readU32();
    const message = iter.readI32();
    const networkId = NetworkIdCodec.decode(iter);
    const value = iter.readF32();
    const data = iter.remaining > 0 ? iter.readBytes(iter.remaining) : new Uint8Array(0);
    const decodedSubtype = tryDecodeSubtype(message, data, (bytes) => new ReadIterator(bytes));
    return new ObjControllerMessage(flags, message, networkId, value, data, decodedSubtype);
  }
}

export const ObjControllerMessageDecoder = registerMessage(asDecoder(ObjControllerMessage));
