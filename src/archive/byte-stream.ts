/**
 * Concrete IByteStream: a growable little-endian byte buffer used on the
 * encode side of every message.
 *
 * Maps to:
 *   /home/tharper/code/swg-main/src/external/ours/library/archive/src/shared/ByteStream.{h,cpp}
 *
 * The C++ ByteStream is a copy-on-write reference-counted blob with a
 * DataFreeList allocator. We don't need any of that gymnastic in
 * TypeScript — a single growable Buffer is fine.
 *
 * Endianness: ALL writes are little-endian (x86 native, no `htonl` in
 * the C++ Archive layer).
 */
import { Buffer } from 'node:buffer';
import type { IByteStream } from './interface.js';

const INITIAL_CAPACITY = 64;
const GROWTH_FACTOR = 2;

export class ByteStream implements IByteStream {
  private buf: Buffer;
  /** Bytes written so far (== logical length) */
  private writePos: number;

  constructor(initialCapacity: number = INITIAL_CAPACITY) {
    this.buf = Buffer.allocUnsafe(Math.max(initialCapacity, 8));
    this.writePos = 0;
  }

  get length(): number {
    return this.writePos;
  }

  /** Materialize the buffer as an immutable Uint8Array (copy). */
  toBytes(): Uint8Array {
    const out = new Uint8Array(this.writePos);
    out.set(this.buf.subarray(0, this.writePos));
    return out;
  }

  /** Return the underlying Buffer windowed to the written region (no copy). */
  toBuffer(): Buffer {
    // Buffer.from with offset+length gives a Buffer view sharing memory;
    // we intentionally return a *new* Buffer slice that views the same
    // backing memory so callers can hand it to write() without aliasing
    // the live writePos.
    return this.buf.subarray(0, this.writePos);
  }

  writeBytes(b: Uint8Array): void {
    this.ensureCapacity(b.byteLength);
    // Buffer.set accepts both Buffer and Uint8Array
    this.buf.set(b, this.writePos);
    this.writePos += b.byteLength;
  }

  writeU8(v: number): void {
    this.ensureCapacity(1);
    this.buf.writeUInt8(v & 0xff, this.writePos);
    this.writePos += 1;
  }

  writeI8(v: number): void {
    this.ensureCapacity(1);
    this.buf.writeInt8(((v << 24) >> 24) | 0, this.writePos);
    this.writePos += 1;
  }

  writeU16(v: number): void {
    this.ensureCapacity(2);
    this.buf.writeUInt16LE(v & 0xffff, this.writePos);
    this.writePos += 2;
  }

  writeI16(v: number): void {
    this.ensureCapacity(2);
    this.buf.writeInt16LE(((v << 16) >> 16) | 0, this.writePos);
    this.writePos += 2;
  }

  writeU32(v: number): void {
    this.ensureCapacity(4);
    this.buf.writeUInt32LE(v >>> 0, this.writePos);
    this.writePos += 4;
  }

  writeI32(v: number): void {
    this.ensureCapacity(4);
    this.buf.writeInt32LE(v | 0, this.writePos);
    this.writePos += 4;
  }

  writeU64(v: bigint): void {
    this.ensureCapacity(8);
    this.buf.writeBigUInt64LE(BigInt.asUintN(64, v), this.writePos);
    this.writePos += 8;
  }

  writeI64(v: bigint): void {
    this.ensureCapacity(8);
    this.buf.writeBigInt64LE(BigInt.asIntN(64, v), this.writePos);
    this.writePos += 8;
  }

  writeF32(v: number): void {
    this.ensureCapacity(4);
    this.buf.writeFloatLE(v, this.writePos);
    this.writePos += 4;
  }

  writeF64(v: number): void {
    this.ensureCapacity(8);
    this.buf.writeDoubleLE(v, this.writePos);
    this.writePos += 8;
  }

  writeBool(v: boolean): void {
    this.writeU8(v ? 1 : 0);
  }

  private ensureCapacity(needed: number): void {
    const required = this.writePos + needed;
    if (required <= this.buf.byteLength) {
      return;
    }
    let newCap = this.buf.byteLength;
    while (newCap < required) {
      newCap = newCap < 4096 ? newCap * GROWTH_FACTOR + needed : newCap + needed;
    }
    const grown = Buffer.allocUnsafe(newCap);
    this.buf.copy(grown, 0, 0, this.writePos);
    this.buf = grown;
  }
}
