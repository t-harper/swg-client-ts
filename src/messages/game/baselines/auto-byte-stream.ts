/**
 * Helpers for the AutoByteStream framing used inside `BaselinesMessage`
 * packages.
 *
 * AutoByteStream::pack always emits:
 *   [u16 LE memberCount][member0 bytes][member1 bytes]...
 *
 * where each member is packed via `AutoVariableBase::pack`, which for an
 * `AutoDeltaVariable<T>` resolves to `Archive::put(target, currentValue)` —
 * i.e. the same on-wire layout as the underlying type T.
 *
 * AutoDeltaByteStream extends AutoByteStream and inherits `pack()` unchanged
 * — full baselines use that, NOT `packDeltas()`. So a baseline payload is
 * just `[u16 memberCount][members...]` with no per-variable index prefix.
 *
 * Source:
 *   /home/tharper/code/swg-main/src/external/ours/library/archive/src/shared/AutoByteStream.cpp:96-105
 *   /home/tharper/code/swg-main/src/external/ours/library/archive/src/shared/AutoDeltaByteStream.cpp (inherits AutoByteStream::pack)
 */

import type { IByteStream, IReadIterator } from '../../../archive/interface.js';

/**
 * Read the leading `[u16 memberCount]` from an AutoByteStream payload, validate
 * it matches the expected count, and return it. Throws on mismatch so the
 * registry's outer try/catch can dispatch the diagnostic.
 *
 * NOTE: We're strict-equality on member count. The server side packs ALL
 * members in `addVariable()` order — there's no "send only N of M" mode for
 * full baselines (that's what `packDeltas()` is for). If the count is wrong,
 * we've got a wire-format drift between client and server and should fail
 * fast rather than misinterpret bytes.
 */
export function readAndCheckMemberCount(iter: IReadIterator, expected: number): number {
  const got = iter.readU16();
  if (got !== expected) {
    throw new Error(`AutoByteStream memberCount mismatch: expected ${expected}, got ${got}`);
  }
  return got;
}

/**
 * Write the `[u16 memberCount]` prefix at the head of an AutoByteStream
 * payload. Symmetric with `readAndCheckMemberCount`.
 */
export function writeMemberCount(stream: IByteStream, count: number): void {
  if (count < 0 || count > 0xffff) {
    throw new RangeError(`memberCount must fit in u16; got ${count}`);
  }
  stream.writeU16(count);
}
