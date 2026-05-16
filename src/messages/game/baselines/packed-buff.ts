/**
 * `Buff::PackedBuff` codec — one entry in a creature's active buff map.
 *
 * Wire layout (matches `Buff.cpp::Archive::put`):
 *   [u32]            endtime         (epoch seconds when the buff expires)
 *   [f32]            value           (magnitude of the buff)
 *   [u32]            duration        (original duration in seconds)
 *   [NetworkId i64]  caster          (who applied the buff; `0n` if invalid)
 *   [u32]            stackCount      (current stack count, 1 for non-stackable)
 *
 * Source:
 *   /home/tharper/code/swg-main/src/engine/shared/library/sharedGame/src/shared/object/Buff.cpp:128-146
 */

import type { IByteStream, ICodec, IReadIterator } from '../../../archive/interface.js';
import { NetworkIdCodec } from '../../../archive/network-id.js';
import type { NetworkId } from '../../../types.js';

export interface PackedBuffValue {
  /** Epoch seconds when the buff expires. */
  endtime: number;
  /** Magnitude (skillmod amount, percent, etc.). Buff-specific interpretation. */
  value: number;
  /** Original duration in seconds. */
  duration: number;
  /** NetworkId of the caster; `0n` (= `NetworkId::cms_invalid`) if not tracked. */
  caster: NetworkId;
  /** Current stack count (>= 1). */
  stackCount: number;
}

export const PackedBuffCodec: ICodec<PackedBuffValue> = {
  encode(stream: IByteStream, value: PackedBuffValue): void {
    stream.writeU32(value.endtime);
    stream.writeF32(value.value);
    stream.writeU32(value.duration);
    NetworkIdCodec.encode(stream, value.caster);
    stream.writeU32(value.stackCount);
  },
  decode(iter: IReadIterator): PackedBuffValue {
    const endtime = iter.readU32();
    const value = iter.readF32();
    const duration = iter.readU32();
    const caster = NetworkIdCodec.decode(iter);
    const stackCount = iter.readU32();
    return { endtime, value, duration, caster, stackCount };
  },
};
