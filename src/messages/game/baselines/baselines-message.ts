/**
 * BaselinesMessage — server-to-client. The carrier for full-object
 * baselines: target NetworkId + object-type Tag + which package + the
 * AutoByteStream-packed payload.
 *
 * One BaselinesMessage carries ONE package (one of BASELINES_CLIENT_SERVER,
 * BASELINES_SHARED, etc.) for ONE object. During zone-in the server typically
 * sends 4-6 BaselinesMessages per object (one per visible package).
 *
 * Wire layout (AutoByteStream framing — `cmd` + 4 payload AutoVariables):
 *   [u16 LE 5]                  varCount (handled by base)
 *   [u32 LE typeCrc]            cmd (handled by base — constcrc('BaselinesMessage'))
 *   [i64 LE NetworkId]          target
 *   [u32 LE Tag]                typeId    (e.g. 0x4F4E4154 = 'TANO')
 *   [u8 packageId]              packageId (one of BASELINES_*)
 *   [u32 LE packageLen]         length prefix on AutoVariable<ByteStream>
 *   [packageLen bytes]          package contents (an AutoByteStream::pack output:
 *                               [u16 memberCount][member0][member1]...)
 *
 * The package contents are dispatched through `baselineRegistry` keyed by
 * (typeId, packageId). If a decoder is registered, `decodedBaseline` is set
 * to `{ kind, data }`. If not (or if decoding throws), `decodedBaseline` is
 * `null` and consumers can inspect the raw `packageBytes`.
 *
 * Source:
 *   /home/tharper/code/swg-main/src/engine/shared/library/sharedNetworkMessages/src/shared/common/BaselinesMessage.{h,cpp}
 */

import type { IByteStream, IReadIterator } from '../../../archive/interface.js';
import { NetworkIdCodec } from '../../../archive/network-id.js';
import { ReadIterator } from '../../../archive/read-iterator.js';
import type { NetworkId } from '../../../types.js';
import { GameNetworkMessage, asDecoder, defineMessageMeta } from '../../base.js';
import { registerMessage } from '../../registry.js';
import { type DecodedBaseline, tagToString, tryDecodeBaseline } from './registry.js';

const META = defineMessageMeta('BaselinesMessage');

export class BaselinesMessage extends GameNetworkMessage {
  static override readonly messageName = META.messageName;
  static readonly typeCrc = META.typeCrc;
  /** cmd + target + typeId + packageId + package */
  static override readonly varCount = 5;

  /** Diagnostic: human-readable typeId (e.g. "TANO", "PLAY", "CREO"). */
  public readonly typeIdString: string;

  constructor(
    /** NetworkId of the object being baselined. */
    public readonly target: NetworkId,
    /** Object-type Tag (u32 — 4 ASCII chars little-endian). */
    public readonly typeId: number,
    /** Which BASELINES_* package this is (1, 3, 4, 6, 8, 9, etc.). */
    public readonly packageId: number,
    /** Raw bytes of the inner AutoByteStream package, BEFORE the u32 length prefix. */
    public readonly packageBytes: Uint8Array = new Uint8Array(0),
    /**
     * Decoded baseline if a `(typeId, packageId)` decoder is registered AND
     * decoding succeeded; otherwise `null`. Consumers inspecting `data` can
     * `instanceof`/`kind`-test against the known kinds in `index.ts`.
     */
    public readonly decodedBaseline: DecodedBaseline | null = null,
  ) {
    super();
    this.typeIdString = tagToString(typeId);
  }

  encodePayload(stream: IByteStream): void {
    NetworkIdCodec.encode(stream, this.target);
    stream.writeU32(this.typeId);
    stream.writeU8(this.packageId);
    // AutoVariable<ByteStream> wire: [u32 length][bytes]
    stream.writeU32(this.packageBytes.length);
    if (this.packageBytes.length > 0) {
      stream.writeBytes(this.packageBytes);
    }
  }

  static decodePayload(iter: IReadIterator): BaselinesMessage {
    const target = NetworkIdCodec.decode(iter);
    const typeId = iter.readU32();
    const packageId = iter.readU8();
    const packageLen = iter.readU32();
    const packageBytes = packageLen > 0 ? iter.readBytes(packageLen) : new Uint8Array(0);
    // Dispatch through the registry. Failures (no decoder OR decode threw) yield null.
    const decodedBaseline = tryDecodeBaseline(
      typeId,
      packageId,
      packageBytes,
      (bytes) => new ReadIterator(bytes),
    );
    return new BaselinesMessage(target, typeId, packageId, packageBytes, decodedBaseline);
  }
}

export const BaselinesMessageDecoder = registerMessage(asDecoder(BaselinesMessage));
