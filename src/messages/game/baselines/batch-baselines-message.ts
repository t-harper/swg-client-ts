/**
 * BatchBaselinesMessage — server-to-client. The actual wire envelope used
 * for the baseline flood during zone-in: a single GameNetworkMessage
 * carrying a `std::vector<BatchBaselinesMessageData>`, each entry mirroring
 * a `BaselinesMessage` (NetworkId target + objectType Tag + packageId +
 * package bytes).
 *
 * Wire layout (AutoByteStream framing — `cmd` + 1 payload AutoVariable):
 *   [u16 LE 2]                  varCount (handled by base)
 *   [u32 LE typeCrc]            cmd (handled by base — constcrc('BatchBaselinesMessage'))
 *   [u32 LE count]              `std::vector` length
 *   {
 *     [i64 LE NetworkId]        target
 *     [u32 LE Tag]              typeId
 *     [u8]                      packageId
 *     [u32 LE byteLen][bytes]   package
 *   } * count
 *
 * Each entry is dispatched through `baselineRegistry` (via `tryDecodeBaseline`)
 * and exposed via the `baselines` field as fully-decoded `BaselinesMessage`
 * instances so consumers can treat batch + non-batch identically.
 *
 * Source:
 *   /home/tharper/code/swg-main/src/engine/shared/library/sharedNetworkMessages/src/shared/common/BatchBaselinesMessage.{h,cpp}
 */

import type { IByteStream, IReadIterator } from '../../../archive/interface.js';
import { NetworkIdCodec } from '../../../archive/network-id.js';
import { ReadIterator } from '../../../archive/read-iterator.js';
import { GameNetworkMessage, asDecoder, defineMessageMeta } from '../../base.js';
import { registerMessage } from '../../registry.js';
import { BaselinesMessage } from './baselines-message.js';
import { tryDecodeBaseline } from './registry.js';

const META = defineMessageMeta('BatchBaselinesMessage');

export class BatchBaselinesMessage extends GameNetworkMessage {
  static override readonly messageName = META.messageName;
  static readonly typeCrc = META.typeCrc;
  /** cmd + data vector */
  static override readonly varCount = 2;

  constructor(
    /** Decoded BaselinesMessage entries — one per vector entry, same dispatch. */
    public readonly baselines: BaselinesMessage[],
  ) {
    super();
  }

  encodePayload(stream: IByteStream): void {
    stream.writeU32(this.baselines.length);
    for (const b of this.baselines) {
      NetworkIdCodec.encode(stream, b.target);
      stream.writeU32(b.typeId);
      stream.writeU8(b.packageId);
      stream.writeU32(b.packageBytes.length);
      if (b.packageBytes.length > 0) {
        stream.writeBytes(b.packageBytes);
      }
    }
  }

  static decodePayload(iter: IReadIterator): BatchBaselinesMessage {
    const count = iter.readU32();
    const baselines: BaselinesMessage[] = [];
    for (let i = 0; i < count; i++) {
      const target = NetworkIdCodec.decode(iter);
      const typeId = iter.readU32();
      const packageId = iter.readU8();
      const packageLen = iter.readU32();
      const packageBytes = packageLen > 0 ? iter.readBytes(packageLen) : new Uint8Array(0);
      const decodedBaseline = tryDecodeBaseline(
        typeId,
        packageId,
        packageBytes,
        (bytes) => new ReadIterator(bytes),
      );
      baselines.push(new BaselinesMessage(target, typeId, packageId, packageBytes, decodedBaseline));
    }
    return new BatchBaselinesMessage(baselines);
  }
}

export const BatchBaselinesMessageDecoder = registerMessage(asDecoder(BatchBaselinesMessage));
