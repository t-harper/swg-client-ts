/**
 * Public interface for the Archive (de)serialization layer.
 * Concrete implementations live in `byte-stream.ts`, `primitives.ts`, etc.
 *
 * Maps to:
 *   /home/tharper/code/swg-main/src/external/ours/library/archive/src/shared/
 *     ByteStream.h
 *     Archive.h
 *     AutoByteStream.h
 *
 * Endianness: little-endian for ALL Archive primitives (x86 native).
 */

/** Mutable byte buffer being written to. Used on the encode side. */
export interface IByteStream {
  /** Current write position (== total bytes written so far) */
  readonly length: number;

  /** Materialize the buffer as an immutable Uint8Array (copy) */
  toBytes(): Uint8Array;

  /** Append raw bytes */
  writeBytes(b: Uint8Array): void;

  // Little-endian primitive writes (no length framing — caller manages structure)
  writeU8(v: number): void;
  writeI8(v: number): void;
  writeU16(v: number): void;
  writeI16(v: number): void;
  writeU32(v: number): void;
  writeI32(v: number): void;
  writeU64(v: bigint): void;
  writeI64(v: bigint): void;
  writeF32(v: number): void;
  writeF64(v: number): void;
  writeBool(v: boolean): void;
}

/** Read cursor over an immutable byte buffer. Used on the decode side. */
export interface IReadIterator {
  /** Total length of the underlying buffer */
  readonly length: number;
  /** Current read position */
  readonly position: number;
  /** Bytes remaining (length - position) */
  readonly remaining: number;

  /** Advance the cursor by N bytes and return them */
  readBytes(n: number): Uint8Array;

  /** Peek without advancing */
  peekU8(offset?: number): number;

  // Little-endian primitive reads
  readU8(): number;
  readI8(): number;
  readU16(): number;
  readI16(): number;
  readU32(): number;
  readI32(): number;
  readU64(): bigint;
  readI64(): bigint;
  readF32(): number;
  readF64(): number;
  readBool(): boolean;

  /**
   * Throw if we're trying to read past the end.
   * Mirrors C++ `Archive::ReadException` ("read operation would extend past end of buffer").
   */
  ensureRemaining(n: number): void;
}

/**
 * Symmetric encode/decode helpers for complex types.
 * Implementations in `string.ts`, `unicode-string.ts`, `network-id.ts`,
 * `transform.ts`, `containers.ts`.
 */
export interface ICodec<T> {
  encode(stream: IByteStream, value: T): void;
  decode(iter: IReadIterator): T;
}

/** Thrown when a decode reads past end-of-buffer. Maps to C++ Archive::ReadException. */
export class ReadException extends Error {
  constructor(
    message: string,
    public readonly wanted: number,
    public readonly available: number,
  ) {
    super(`${message} (wanted ${wanted} bytes, ${available} available)`);
    this.name = 'ReadException';
  }
}
