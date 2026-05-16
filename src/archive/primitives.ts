/**
 * Codec instances for primitive Archive types. These satisfy `ICodec<T>`
 * and compose with the container codecs (vector/set/AutoArray/etc.).
 *
 * Maps to:
 *   /home/tharper/code/swg-main/src/external/ours/library/archive/src/shared/Archive.h
 *
 * For each primitive there's a singleton codec object so callers can write:
 *
 *   AutoArray(U32).encode(stream, [1, 2, 3])
 *   AutoArray(StringCodec).decode(iter)
 */

import type { IByteStream, ICodec, IReadIterator } from './interface.js';

export const U8: ICodec<number> = {
  encode: (s, v) => s.writeU8(v),
  decode: (i) => i.readU8(),
};

export const I8: ICodec<number> = {
  encode: (s, v) => s.writeI8(v),
  decode: (i) => i.readI8(),
};

export const U16: ICodec<number> = {
  encode: (s, v) => s.writeU16(v),
  decode: (i) => i.readU16(),
};

export const I16: ICodec<number> = {
  encode: (s, v) => s.writeI16(v),
  decode: (i) => i.readI16(),
};

export const U32: ICodec<number> = {
  encode: (s, v) => s.writeU32(v),
  decode: (i) => i.readU32(),
};

export const I32: ICodec<number> = {
  encode: (s, v) => s.writeI32(v),
  decode: (i) => i.readI32(),
};

export const U64: ICodec<bigint> = {
  encode: (s, v) => s.writeU64(v),
  decode: (i) => i.readU64(),
};

export const I64: ICodec<bigint> = {
  encode: (s, v) => s.writeI64(v),
  decode: (i) => i.readI64(),
};

export const F32: ICodec<number> = {
  encode: (s, v) => s.writeF32(v),
  decode: (i) => i.readF32(),
};

export const F64: ICodec<number> = {
  encode: (s, v) => s.writeF64(v),
  decode: (i) => i.readF64(),
};

export const Bool: ICodec<boolean> = {
  encode: (s, v) => s.writeBool(v),
  decode: (i) => i.readBool(),
};

/**
 * Make a codec for an enum-like type that's serialized as a signed int32.
 * The C++ pattern reads an int and reinterprets it as the enum, so we mirror
 * that. The caller supplies the cast (we don't validate enum membership —
 * Archive::get doesn't either).
 */
export function enumI32<T extends number>(): ICodec<T> {
  return {
    encode: (s, v) => s.writeI32(v as number),
    decode: (i) => i.readI32() as T,
  };
}

/**
 * Build a passthrough codec that just delegates to existing encode/decode
 * functions. Useful when wiring up message-specific structs.
 */
export function makeCodec<T>(
  encode: (s: IByteStream, v: T) => void,
  decode: (i: IReadIterator) => T,
): ICodec<T> {
  return { encode, decode };
}
