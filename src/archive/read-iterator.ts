/**
 * Concrete IReadIterator: a read cursor over an immutable byte buffer.
 *
 * Maps to:
 *   /home/tharper/code/swg-main/src/external/ours/library/archive/src/shared/ByteStream.h
 *   (Archive::ReadIterator)
 *
 * Endianness: ALL reads are little-endian.
 */
import { Buffer } from 'node:buffer';
import { type IReadIterator, ReadException } from './interface.js';

export class ReadIterator implements IReadIterator {
  /** Underlying immutable bytes (treated as read-only by this class). */
  private readonly view: Buffer;
  private pos: number;

  /**
   * Accepts either:
   *   - a Uint8Array (its memory is wrapped, NOT copied — caller must not
   *     mutate after handing it over),
   *   - a Buffer (same — wrapped without copy),
   *   - a slice of a parent buffer via offset+length.
   */
  constructor(source: Uint8Array | Buffer, offset = 0, length?: number) {
    const end = length === undefined ? source.byteLength - offset : offset + length;
    if (offset < 0 || end < offset || end > source.byteLength) {
      throw new RangeError(
        `ReadIterator window [${offset}, ${end}) out of bounds for buffer of ${source.byteLength}`,
      );
    }
    // Buffer.from(uint8.buffer, byteOffset, length) shares memory with the
    // input. Works for both Uint8Array and Buffer.
    this.view = Buffer.from(source.buffer, source.byteOffset + offset, end - offset);
    this.pos = 0;
  }

  /**
   * Build a ReadIterator that shares this iterator's underlying memory but
   * starts at a fresh position 0 windowed to the next `n` bytes. The parent
   * cursor advances by `n`. Used for nested decode (e.g. message header
   * peels off the CRC then hands the rest to the per-message decoder).
   */
  subIterator(n: number): ReadIterator {
    this.ensureRemaining(n);
    const sub = new ReadIterator(this.view, this.pos, n);
    this.pos += n;
    return sub;
  }

  get length(): number {
    return this.view.byteLength;
  }

  get position(): number {
    return this.pos;
  }

  get remaining(): number {
    return this.view.byteLength - this.pos;
  }

  ensureRemaining(n: number): void {
    if (this.pos + n > this.view.byteLength) {
      throw new ReadException(
        'Archive::ReadIterator read operation would extend past end of buffer',
        n,
        this.remaining,
      );
    }
  }

  readBytes(n: number): Uint8Array {
    this.ensureRemaining(n);
    // Copy out so callers can hold on to the slice past the iterator's lifetime
    const out = new Uint8Array(n);
    out.set(this.view.subarray(this.pos, this.pos + n));
    this.pos += n;
    return out;
  }

  /** Zero-copy view of the next N bytes. The view becomes invalid once
   * the iterator advances past it; treat as ephemeral. */
  viewBytes(n: number): Buffer {
    this.ensureRemaining(n);
    const v = this.view.subarray(this.pos, this.pos + n);
    this.pos += n;
    return v;
  }

  peekU8(offset = 0): number {
    if (this.pos + offset >= this.view.byteLength || this.pos + offset < 0) {
      throw new ReadException(
        'Archive::ReadIterator peek out of range',
        offset + 1,
        this.remaining,
      );
    }
    return this.view.readUInt8(this.pos + offset);
  }

  readU8(): number {
    this.ensureRemaining(1);
    const v = this.view.readUInt8(this.pos);
    this.pos += 1;
    return v;
  }

  readI8(): number {
    this.ensureRemaining(1);
    const v = this.view.readInt8(this.pos);
    this.pos += 1;
    return v;
  }

  readU16(): number {
    this.ensureRemaining(2);
    const v = this.view.readUInt16LE(this.pos);
    this.pos += 2;
    return v;
  }

  readI16(): number {
    this.ensureRemaining(2);
    const v = this.view.readInt16LE(this.pos);
    this.pos += 2;
    return v;
  }

  readU32(): number {
    this.ensureRemaining(4);
    const v = this.view.readUInt32LE(this.pos);
    this.pos += 4;
    return v;
  }

  readI32(): number {
    this.ensureRemaining(4);
    const v = this.view.readInt32LE(this.pos);
    this.pos += 4;
    return v;
  }

  readU64(): bigint {
    this.ensureRemaining(8);
    const v = this.view.readBigUInt64LE(this.pos);
    this.pos += 8;
    return v;
  }

  readI64(): bigint {
    this.ensureRemaining(8);
    const v = this.view.readBigInt64LE(this.pos);
    this.pos += 8;
    return v;
  }

  readF32(): number {
    this.ensureRemaining(4);
    const v = this.view.readFloatLE(this.pos);
    this.pos += 4;
    return v;
  }

  readF64(): number {
    this.ensureRemaining(8);
    const v = this.view.readDoubleLE(this.pos);
    this.pos += 8;
    return v;
  }

  readBool(): boolean {
    // C++ writes `bool` as a single byte. 0 = false, anything else = true
    // (the in-codebase convention is 0/1 but we tolerate other values for
    // robustness — Archive::get(bool) does no validation).
    return this.readU8() !== 0;
  }
}
