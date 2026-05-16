/**
 * Unicode::String codec — UTF-16 LE characters with a 32-bit little-endian
 * char-count prefix (NOT byte count).
 *
 * Maps to:
 *   /home/tharper/code/swg-main/src/external/ours/library/unicodeArchive/src/shared/UnicodeArchive.cpp
 *
 * C++ side:
 *   typedef unsigned short unicode_char_t;
 *   typedef std::basic_string<unicode_char_t> String;
 *   put: write `uint32 source.size()`, then `source.size() * 2` bytes
 *   get: read `uint32 size`, then assign `size` unicode_char_t values
 *
 * That means SWG uses fixed 16-bit code-units (UCS-2 / UTF-16 with no
 * surrogate handling) on the wire. We expose JS strings on the public API
 * and encode them as UTF-16 LE — for chat content with non-BMP codepoints
 * this could fall apart at the surrogate boundary, but every name + chat
 * string in the codebase fits in the BMP. For the login messages we
 * actually use (no Unicode::String fields), this codec exists for Stream C.
 */

import { Buffer } from 'node:buffer';
import type { IByteStream, ICodec, IReadIterator } from './interface.js';

export function writeUnicodeString(stream: IByteStream, value: string): void {
  // JS string.length gives UTF-16 code-unit count, matching unicode_char_t
  stream.writeU32(value.length);
  if (value.length === 0) {
    return;
  }
  const buf = Buffer.alloc(value.length * 2);
  for (let i = 0; i < value.length; i++) {
    buf.writeUInt16LE(value.charCodeAt(i), i * 2);
  }
  stream.writeBytes(buf);
}

export function readUnicodeString(iter: IReadIterator): string {
  const count = iter.readU32();
  if (count === 0) {
    return '';
  }
  // Use a Buffer view so we can use readUInt16LE which is bounds-checked
  // by Buffer itself — avoids the noUncheckedIndexedAccess `undefined` hop.
  const bytes = iter.readBytes(count * 2);
  const view = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let s = '';
  for (let i = 0; i < count; i++) {
    s += String.fromCharCode(view.readUInt16LE(i * 2));
  }
  return s;
}

export const UnicodeStringCodec: ICodec<string> = {
  encode: writeUnicodeString,
  decode: readUnicodeString,
};
