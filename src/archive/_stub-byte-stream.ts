/**
 * TEMPORARY STUB — Stream C scaffolding while Stream B implements the real
 * `byte-stream.ts`, `primitives.ts`, `string.ts`, etc.
 *
 * After Phase 2 merge:
 *  1. Delete this file.
 *  2. Replace all `from '../archive/_stub-byte-stream.js'` imports under
 *     `src/messages/{connection,game}/` with imports from the real Archive
 *     module (`../archive/byte-stream.js`, `../archive/string.js`, etc.).
 *
 * The signatures here match the public `IByteStream`/`IReadIterator`
 * interfaces in `src/archive/interface.ts` so message subclasses compile
 * against either implementation. Every primitive throws — the stub is for
 * shape-checking only; round-trip tests require Stream B's real Archive.
 */

import type { IByteStream, IReadIterator } from './interface.js';
import type { NetworkId, Vector3 } from '../types.js';

const NOT_IMPLEMENTED = 'Stream C stub: real Archive lives in Stream B. Wait for Phase 2 merge.';

// ---------- ByteStream stub ----------

export class StubByteStream implements IByteStream {
  // biome-ignore lint/style/useReadonlyClassProperties: stub
  private _length = 0;
  get length(): number {
    return this._length;
  }

  toBytes(): Uint8Array {
    throw new Error(NOT_IMPLEMENTED);
  }
  writeBytes(_b: Uint8Array): void {
    throw new Error(NOT_IMPLEMENTED);
  }
  writeU8(_v: number): void {
    throw new Error(NOT_IMPLEMENTED);
  }
  writeI8(_v: number): void {
    throw new Error(NOT_IMPLEMENTED);
  }
  writeU16(_v: number): void {
    throw new Error(NOT_IMPLEMENTED);
  }
  writeI16(_v: number): void {
    throw new Error(NOT_IMPLEMENTED);
  }
  writeU32(_v: number): void {
    throw new Error(NOT_IMPLEMENTED);
  }
  writeI32(_v: number): void {
    throw new Error(NOT_IMPLEMENTED);
  }
  writeU64(_v: bigint): void {
    throw new Error(NOT_IMPLEMENTED);
  }
  writeI64(_v: bigint): void {
    throw new Error(NOT_IMPLEMENTED);
  }
  writeF32(_v: number): void {
    throw new Error(NOT_IMPLEMENTED);
  }
  writeF64(_v: number): void {
    throw new Error(NOT_IMPLEMENTED);
  }
  writeBool(_v: boolean): void {
    throw new Error(NOT_IMPLEMENTED);
  }
}

// ---------- ReadIterator stub ----------

export class StubReadIterator implements IReadIterator {
  readonly length = 0;
  readonly position = 0;
  readonly remaining = 0;

  readBytes(_n: number): Uint8Array {
    throw new Error(NOT_IMPLEMENTED);
  }
  peekU8(_offset?: number): number {
    throw new Error(NOT_IMPLEMENTED);
  }
  readU8(): number {
    throw new Error(NOT_IMPLEMENTED);
  }
  readI8(): number {
    throw new Error(NOT_IMPLEMENTED);
  }
  readU16(): number {
    throw new Error(NOT_IMPLEMENTED);
  }
  readI16(): number {
    throw new Error(NOT_IMPLEMENTED);
  }
  readU32(): number {
    throw new Error(NOT_IMPLEMENTED);
  }
  readI32(): number {
    throw new Error(NOT_IMPLEMENTED);
  }
  readU64(): bigint {
    throw new Error(NOT_IMPLEMENTED);
  }
  readI64(): bigint {
    throw new Error(NOT_IMPLEMENTED);
  }
  readF32(): number {
    throw new Error(NOT_IMPLEMENTED);
  }
  readF64(): number {
    throw new Error(NOT_IMPLEMENTED);
  }
  readBool(): boolean {
    throw new Error(NOT_IMPLEMENTED);
  }
  ensureRemaining(_n: number): void {
    throw new Error(NOT_IMPLEMENTED);
  }
}

// ---------- Higher-level codecs (stubbed) ----------
//
// Stream B will provide real implementations of:
//   writeString / readString               — std::string (u16 length + UTF-8; >=0xFFFF escape)
//   writeUnicodeString / readUnicodeString — Unicode::String (u32 char-count + UTF-16 LE)
//   writeNetworkId / readNetworkId         — 8-byte LE uint64
//   writeTransform / readTransform         — Quaternion (4 floats) + Vector (3 floats) = 7 floats
//
// The message classes import via the names below and Phase 2 will swap
// these for the real exports.

export function writeString(_stream: IByteStream, _value: string): void {
  throw new Error(NOT_IMPLEMENTED);
}
export function readString(_iter: IReadIterator): string {
  throw new Error(NOT_IMPLEMENTED);
}

export function writeUnicodeString(_stream: IByteStream, _value: string): void {
  throw new Error(NOT_IMPLEMENTED);
}
export function readUnicodeString(_iter: IReadIterator): string {
  throw new Error(NOT_IMPLEMENTED);
}

export function writeNetworkId(_stream: IByteStream, _value: NetworkId): void {
  throw new Error(NOT_IMPLEMENTED);
}
export function readNetworkId(_iter: IReadIterator): NetworkId {
  throw new Error(NOT_IMPLEMENTED);
}

/**
 * Transform = Quaternion (x, y, z, w as 4 f32) + Vector (x, y, z as 3 f32) = 28 bytes.
 * See:
 *   /home/tharper/code/swg-main/src/engine/shared/library/sharedMathArchive/src/shared/TransformArchive.h
 *   /home/tharper/code/swg-main/src/engine/shared/library/sharedMathArchive/src/shared/QuaternionArchive.h
 *   /home/tharper/code/swg-main/src/engine/shared/library/sharedMathArchive/src/shared/VectorArchive.h
 */
export interface Transform {
  rotation: { x: number; y: number; z: number; w: number };
  position: Vector3;
}

export function writeTransform(_stream: IByteStream, _value: Transform): void {
  throw new Error(NOT_IMPLEMENTED);
}
export function readTransform(_iter: IReadIterator): Transform {
  throw new Error(NOT_IMPLEMENTED);
}

export function writeVector3(_stream: IByteStream, _value: Vector3): void {
  throw new Error(NOT_IMPLEMENTED);
}
export function readVector3(_iter: IReadIterator): Vector3 {
  throw new Error(NOT_IMPLEMENTED);
}

/**
 * AutoArray<T> = `[u32 count][T x count]` on the wire.
 * (Matches `Archive::put(ByteStream, const std::vector<A> &)` in Archive.h:346.)
 *
 * Stream B will export `writeArray` / `readArray` helpers; we use these
 * thin wrappers so message classes don't have to know the framing.
 */
export function writeArray<T>(
  stream: IByteStream,
  values: readonly T[],
  writeElement: (s: IByteStream, v: T) => void,
): void {
  stream.writeU32(values.length);
  for (const v of values) writeElement(stream, v);
}

export function readArray<T>(
  iter: IReadIterator,
  readElement: (i: IReadIterator) => T,
): T[] {
  const count = iter.readU32();
  const out: T[] = [];
  for (let i = 0; i < count; ++i) out.push(readElement(iter));
  return out;
}
