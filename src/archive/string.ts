/**
 * std::string codec — UTF-8 bytes (treated as opaque by C++) framed with
 * a 16-bit little-endian length prefix. For strings whose byte length is
 * >= 65535 the prefix becomes 0xFFFF followed by a 32-bit actual length.
 *
 * Maps to:
 *   /home/tharper/code/swg-main/src/external/ours/library/archive/src/shared/Archive.h
 *   lines 89-101 (get) and 295-310 (put).
 *
 * The codebase treats std::string as a raw byte container; characters in
 * usernames and the like are ASCII. To stay safe with any input we encode
 * via TextEncoder (UTF-8) and decode via TextDecoder (also UTF-8). For
 * round-tripping arbitrary binary the bytes-in/bytes-out is preserved
 * exactly when callers use ASCII.
 */

import { Buffer } from 'node:buffer';
import type { IByteStream, ICodec, IReadIterator } from './interface.js';

const U16_MAX_INLINE = 65535;

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8');

/**
 * Encode a JS string by writing its UTF-8 byte length (NOT codepoint
 * count) framed as described above, followed by the UTF-8 bytes.
 *
 * Note: matches `std::string`'s `size()` which is a byte count, so the
 * length prefix is in bytes — not in codepoints / not in chars.
 */
export function writeStdString(stream: IByteStream, value: string): void {
  // Buffer.byteLength gives UTF-8 byte length without allocating
  // a TextEncoder result first
  const byteLen = Buffer.byteLength(value, 'utf-8');
  if (byteLen < U16_MAX_INLINE) {
    stream.writeU16(byteLen);
  } else {
    stream.writeU16(U16_MAX_INLINE);
    stream.writeU32(byteLen);
  }
  if (byteLen > 0) {
    stream.writeBytes(encoder.encode(value));
  }
}

export function readStdString(iter: IReadIterator): string {
  const lenU16 = iter.readU16();
  const byteLen = lenU16 < U16_MAX_INLINE ? lenU16 : iter.readU32();
  if (byteLen === 0) {
    return '';
  }
  const bytes = iter.readBytes(byteLen);
  return decoder.decode(bytes);
}

export const StringCodec: ICodec<string> = {
  encode: writeStdString,
  decode: readStdString,
};
