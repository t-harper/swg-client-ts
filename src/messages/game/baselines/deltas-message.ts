/**
 * DeltasMessage — server-to-client. The per-object incremental-update
 * counterpart to `BaselinesMessage`.
 *
 * After the zone-in baseline flood completes, anything that subsequently
 * mutates a watched `AutoDeltaVariable` on an object (HAM tick, posture
 * change, container add/remove, attribute mod, etc.) is broadcast as a
 * `DeltasMessage` to every client observing that object's package set.
 * Without delta decoding the client's view of the world goes stale the
 * moment baselines end — every HAM update, posture change, item move, etc.
 * is invisible.
 *
 * Wire layout (AutoByteStream framing — `cmd` + 4 payload AutoVariables):
 *   [u16 LE 5]                  varCount (handled by base)
 *   [u32 LE typeCrc]            cmd (handled by base — constcrc('DeltasMessage'))
 *   [i64 LE NetworkId]          target
 *   [u32 LE Tag]                typeId    (e.g. 0x4F4E4154 = 'TANO')
 *   [u8 packageId]              packageId (one of DELTAS_*)
 *   [u32 LE packageLen]         length prefix on AutoVariable<ByteStream>
 *   [packageLen bytes]          delta blob — see below
 *
 * The inner `package` blob produced by `AutoDeltaByteStream::packDeltas`:
 *   [u16 LE count]              number of dirty fields (informational —
 *                               the receiver actually loops while bytes
 *                               remain in the source iterator)
 *   for each dirty field:
 *     [u16 LE fieldIndex]       position in the package's addVariable order
 *     [type-specific bytes]     new value (primitive) OR an AutoDelta*
 *                               command sequence (set/map/vector)
 *
 * The package contents are dispatched through `deltaRegistry` keyed by
 * `(typeId, packageId)`. If a decoder is registered, `decodedDelta` is set
 * to `{ kind, data }` where `data` is a `Partial<BaselineType>` carrying
 * just the fields that changed. If not, `decodedDelta` is `null` and
 * consumers can inspect the raw `packageBytes` for forensic purposes.
 *
 * Source:
 *   /home/tharper/code/swg-main/src/engine/shared/library/sharedNetworkMessages/src/shared/common/DeltasMessage.{h,cpp}
 *   /home/tharper/code/swg-main/src/external/ours/library/archive/src/shared/AutoDeltaByteStream.cpp:122-188
 */

import type { IByteStream, IReadIterator } from '../../../archive/interface.js';
import { NetworkIdCodec } from '../../../archive/network-id.js';
import { ReadIterator } from '../../../archive/read-iterator.js';
import type { NetworkId } from '../../../types.js';
import { GameNetworkMessage, asDecoder, defineMessageMeta } from '../../base.js';
import { registerMessage } from '../../registry.js';
import { type DecodedDelta, tryDecodeDelta } from './delta-registry.js';
import { tagToString } from './registry.js';

const META = defineMessageMeta('DeltasMessage');

export class DeltasMessage extends GameNetworkMessage {
  static override readonly messageName = META.messageName;
  static readonly typeCrc = META.typeCrc;
  /** cmd + target + typeId + packageId + package */
  static override readonly varCount = 5;

  /** Diagnostic: human-readable typeId (e.g. "TANO", "PLAY", "CREO"). */
  public readonly typeIdString: string;

  constructor(
    /** NetworkId of the object that mutated. */
    public readonly target: NetworkId,
    /** Object-type Tag (u32 — 4 ASCII chars little-endian). */
    public readonly typeId: number,
    /** Which DELTAS_* package this is (1, 3, 4, 6, 8, 9, etc.). */
    public readonly packageId: number,
    /** Raw bytes of the inner packDeltas blob, BEFORE the u32 length prefix. */
    public readonly packageBytes: Uint8Array = new Uint8Array(0),
    /**
     * Decoded delta if a `(typeId, packageId)` decoder is registered AND
     * decoding succeeded; otherwise `null`. `data` is a sparse object —
     * only the fields that changed in this packet are present.
     */
    public readonly decodedDelta: DecodedDelta | null = null,
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

  static decodePayload(iter: IReadIterator): DeltasMessage {
    const target = NetworkIdCodec.decode(iter);
    const typeId = iter.readU32();
    const packageId = iter.readU8();
    const packageLen = iter.readU32();
    const packageBytes = packageLen > 0 ? iter.readBytes(packageLen) : new Uint8Array(0);
    // Dispatch through the registry. Failures (no decoder OR decode threw) yield null.
    const decodedDelta = tryDecodeDelta(
      typeId,
      packageId,
      packageBytes,
      (bytes) => new ReadIterator(bytes),
    );
    return new DeltasMessage(target, typeId, packageId, packageBytes, decodedDelta);
  }
}

export const DeltasMessageDecoder = registerMessage(asDecoder(DeltasMessage));
