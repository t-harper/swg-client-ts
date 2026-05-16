/**
 * TEMPORARY STUB — Stream C scaffolding while Stream B implements the real
 * `byte-stream.ts`, `primitives.ts`, `string.ts`, etc.
 *
 * STATUS: Implements all primitives + container helpers with real working
 * code so message classes can be unit-tested in this worktree (golden-byte
 * tests pass before the Phase 2 merge). The wire format matches the C++
 * implementation byte-for-byte; Stream B's eventual real Archive will
 * produce identical bytes, so the round-trip tests stay green after merge.
 *
 * Once Stream B lands the production implementation, this file gets
 * deleted and the following imports get rewritten:
 *
 *   from '../archive/_stub-byte-stream.js'   →   from '../archive/byte-stream.js'
 *                                                from '../archive/string.js'
 *                                                from '../archive/unicode-string.js'
 *                                                from '../archive/network-id.js'
 *                                                from '../archive/transform.js'
 *                                                from '../archive/containers.js'
 *
 * The wire-format references that govern these implementations:
 *   /home/tharper/code/swg-main/src/external/ours/library/archive/src/shared/Archive.h
 *     — primitives.put/get (Archive.h:218-330) + container templates (Archive.h:346-410)
 *     — std::string put (Archive.h:295): [u16 size; if >=65535 then u16(0xFFFF) + u32 size]
 *                                        + raw bytes
 *   /home/tharper/code/swg-main/src/external/ours/library/unicodeArchive/src/shared/UnicodeArchive.cpp
 *     — Unicode::String put: [u32 char_count] + char_count * 2 bytes UTF-16 LE
 *   /home/tharper/code/swg-main/src/engine/shared/library/sharedFoundation/src/shared/NetworkIdArchive.cpp
 *     — NetworkId / int64 put: 8 bytes LE (signed)
 *   /home/tharper/code/swg-main/src/engine/shared/library/sharedMathArchive/src/shared/{TransformArchive.h,QuaternionArchive.h,VectorArchive.h}
 *     — Transform = Quaternion(x,y,z,w) + Vector(x,y,z) = 7 f32 = 28 bytes
 */

import { Buffer } from 'node:buffer';
import type { NetworkId, Vector3 } from '../types.js';
import type { IByteStream, IReadIterator } from './interface.js';
import { ReadException } from './interface.js';

// ---------- ByteStream ----------

/** Initial capacity for the growable backing buffer. */
const INITIAL_CAPACITY = 64;

export class StubByteStream implements IByteStream {
  private buf: Buffer;
  private view: DataView;
  private pos = 0;

  constructor(initialCapacity = INITIAL_CAPACITY) {
    this.buf = Buffer.alloc(initialCapacity);
    this.view = new DataView(this.buf.buffer, this.buf.byteOffset, this.buf.byteLength);
  }

  get length(): number {
    return this.pos;
  }

  toBytes(): Uint8Array {
    return new Uint8Array(this.buf.subarray(0, this.pos));
  }

  private ensure(n: number): void {
    const need = this.pos + n;
    if (need <= this.buf.length) return;
    let cap = this.buf.length || INITIAL_CAPACITY;
    while (cap < need) cap *= 2;
    const grown = Buffer.alloc(cap);
    this.buf.copy(grown, 0, 0, this.pos);
    this.buf = grown;
    this.view = new DataView(this.buf.buffer, this.buf.byteOffset, this.buf.byteLength);
  }

  writeBytes(b: Uint8Array): void {
    this.ensure(b.length);
    this.buf.set(b, this.pos);
    this.pos += b.length;
  }

  writeU8(v: number): void {
    this.ensure(1);
    this.view.setUint8(this.pos, v);
    this.pos += 1;
  }
  writeI8(v: number): void {
    this.ensure(1);
    this.view.setInt8(this.pos, v);
    this.pos += 1;
  }
  writeU16(v: number): void {
    this.ensure(2);
    this.view.setUint16(this.pos, v, true);
    this.pos += 2;
  }
  writeI16(v: number): void {
    this.ensure(2);
    this.view.setInt16(this.pos, v, true);
    this.pos += 2;
  }
  writeU32(v: number): void {
    this.ensure(4);
    this.view.setUint32(this.pos, v, true);
    this.pos += 4;
  }
  writeI32(v: number): void {
    this.ensure(4);
    this.view.setInt32(this.pos, v, true);
    this.pos += 4;
  }
  writeU64(v: bigint): void {
    this.ensure(8);
    this.view.setBigUint64(this.pos, v, true);
    this.pos += 8;
  }
  writeI64(v: bigint): void {
    this.ensure(8);
    this.view.setBigInt64(this.pos, v, true);
    this.pos += 8;
  }
  writeF32(v: number): void {
    this.ensure(4);
    this.view.setFloat32(this.pos, v, true);
    this.pos += 4;
  }
  writeF64(v: number): void {
    this.ensure(8);
    this.view.setFloat64(this.pos, v, true);
    this.pos += 8;
  }
  writeBool(v: boolean): void {
    this.writeU8(v ? 1 : 0);
  }
}

// ---------- ReadIterator ----------

export class StubReadIterator implements IReadIterator {
  private readonly view: DataView;
  private pos = 0;

  constructor(private readonly buffer: Uint8Array) {
    this.view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  }

  get length(): number {
    return this.buffer.length;
  }
  get position(): number {
    return this.pos;
  }
  get remaining(): number {
    return this.buffer.length - this.pos;
  }

  ensureRemaining(n: number): void {
    if (this.remaining < n) {
      throw new ReadException('read past end of buffer', n, this.remaining);
    }
  }

  readBytes(n: number): Uint8Array {
    this.ensureRemaining(n);
    // Slice copies — safe to mutate without affecting the underlying buffer.
    const out = this.buffer.slice(this.pos, this.pos + n);
    this.pos += n;
    return out;
  }
  peekU8(offset = 0): number {
    if (this.pos + offset >= this.buffer.length) {
      throw new ReadException('peek past end of buffer', offset + 1, this.remaining);
    }
    return this.view.getUint8(this.pos + offset);
  }

  readU8(): number {
    this.ensureRemaining(1);
    const v = this.view.getUint8(this.pos);
    this.pos += 1;
    return v;
  }
  readI8(): number {
    this.ensureRemaining(1);
    const v = this.view.getInt8(this.pos);
    this.pos += 1;
    return v;
  }
  readU16(): number {
    this.ensureRemaining(2);
    const v = this.view.getUint16(this.pos, true);
    this.pos += 2;
    return v;
  }
  readI16(): number {
    this.ensureRemaining(2);
    const v = this.view.getInt16(this.pos, true);
    this.pos += 2;
    return v;
  }
  readU32(): number {
    this.ensureRemaining(4);
    const v = this.view.getUint32(this.pos, true);
    this.pos += 4;
    return v;
  }
  readI32(): number {
    this.ensureRemaining(4);
    const v = this.view.getInt32(this.pos, true);
    this.pos += 4;
    return v;
  }
  readU64(): bigint {
    this.ensureRemaining(8);
    const v = this.view.getBigUint64(this.pos, true);
    this.pos += 8;
    return v;
  }
  readI64(): bigint {
    this.ensureRemaining(8);
    const v = this.view.getBigInt64(this.pos, true);
    this.pos += 8;
    return v;
  }
  readF32(): number {
    this.ensureRemaining(4);
    const v = this.view.getFloat32(this.pos, true);
    this.pos += 4;
    return v;
  }
  readF64(): number {
    this.ensureRemaining(8);
    const v = this.view.getFloat64(this.pos, true);
    this.pos += 8;
    return v;
  }
  readBool(): boolean {
    return this.readU8() !== 0;
  }
}

// ---------- std::string ----------
//
// Archive.h:295 — `[u16 size; if >=65535: u16(0xFFFF) + u32 size_full] + raw bytes`.
// For the messages in scope (Tatooine, "ts-test-XXX", etc.) the long-string
// branch is never exercised; we still implement it for correctness.

const SHORT_STRING_THRESHOLD = 0xffff;

export function writeString(stream: IByteStream, value: string): void {
  const bytes = Buffer.from(value, 'utf8');
  if (bytes.length < SHORT_STRING_THRESHOLD) {
    stream.writeU16(bytes.length);
  } else {
    stream.writeU16(SHORT_STRING_THRESHOLD);
    stream.writeU32(bytes.length);
  }
  stream.writeBytes(bytes);
}

export function readString(iter: IReadIterator): string {
  let len: number = iter.readU16();
  if (len === SHORT_STRING_THRESHOLD) {
    len = iter.readU32();
  }
  const bytes = iter.readBytes(len);
  return Buffer.from(bytes).toString('utf8');
}

// ---------- Unicode::String (UTF-16 LE) ----------
//
// UnicodeArchive.cpp — `[u32 char_count] + char_count * 2 bytes UTF-16 LE`.
// Note this is char-count, NOT byte-count.

export function writeUnicodeString(stream: IByteStream, value: string): void {
  // UTF-16 code units in the JS string. For BMP-only text (everything SWG
  // actually uses), this matches the count the server expects. Surrogate
  // pairs would count as 2 units, which matches UTF-16 LE encoding.
  const codeUnits = value.length;
  stream.writeU32(codeUnits);
  const bytes = Buffer.alloc(codeUnits * 2);
  for (let i = 0; i < codeUnits; ++i) {
    bytes.writeUInt16LE(value.charCodeAt(i), i * 2);
  }
  stream.writeBytes(bytes);
}

export function readUnicodeString(iter: IReadIterator): string {
  const count = iter.readU32();
  const bytes = iter.readBytes(count * 2);
  let out = '';
  for (let i = 0; i < count; ++i) {
    const lo = bytes[i * 2] ?? 0;
    const hi = bytes[i * 2 + 1] ?? 0;
    out += String.fromCharCode(lo | (hi << 8));
  }
  return out;
}

// ---------- NetworkId (int64 LE) ----------

export function writeNetworkId(stream: IByteStream, value: NetworkId): void {
  stream.writeI64(value);
}

export function readNetworkId(iter: IReadIterator): NetworkId {
  return iter.readI64();
}

// ---------- Vector3 / Transform ----------

export function writeVector3(stream: IByteStream, v: Vector3): void {
  stream.writeF32(v.x);
  stream.writeF32(v.y);
  stream.writeF32(v.z);
}

export function readVector3(iter: IReadIterator): Vector3 {
  const x = iter.readF32();
  const y = iter.readF32();
  const z = iter.readF32();
  return { x, y, z };
}

/**
 * Transform = Quaternion (x, y, z, w as 4 f32, in that order) +
 *             Vector (x, y, z as 3 f32) = 28 bytes total.
 * See:
 *   /home/tharper/code/swg-main/src/engine/shared/library/sharedMathArchive/src/shared/TransformArchive.h
 *   /home/tharper/code/swg-main/src/engine/shared/library/sharedMathArchive/src/shared/QuaternionArchive.h
 *   /home/tharper/code/swg-main/src/engine/shared/library/sharedMathArchive/src/shared/VectorArchive.h
 */
export interface Transform {
  rotation: { x: number; y: number; z: number; w: number };
  position: Vector3;
}

export function writeTransform(stream: IByteStream, t: Transform): void {
  stream.writeF32(t.rotation.x);
  stream.writeF32(t.rotation.y);
  stream.writeF32(t.rotation.z);
  stream.writeF32(t.rotation.w);
  writeVector3(stream, t.position);
}

export function readTransform(iter: IReadIterator): Transform {
  const rx = iter.readF32();
  const ry = iter.readF32();
  const rz = iter.readF32();
  const rw = iter.readF32();
  const position = readVector3(iter);
  return { rotation: { x: rx, y: ry, z: rz, w: rw }, position };
}

// ---------- AutoArray<T> ----------
//
// Archive.h:346 — `[i32 length]` then `length` packed elements.
// (Identical wire-shape for std::vector and std::deque; std::set is the same.)

export function writeArray<T>(
  stream: IByteStream,
  values: readonly T[],
  writeElement: (s: IByteStream, v: T) => void,
): void {
  stream.writeU32(values.length);
  for (const v of values) writeElement(stream, v);
}

export function readArray<T>(iter: IReadIterator, readElement: (i: IReadIterator) => T): T[] {
  const count = iter.readU32();
  const out: T[] = [];
  for (let i = 0; i < count; ++i) out.push(readElement(iter));
  return out;
}
