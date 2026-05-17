/**
 * IFF 4-character "tag" helpers.
 *
 * In the SOE IFF format a tag is a `uint32` whose 4 bytes spell a printable
 * ASCII string (e.g. `"FORM"`, `"DATA"`, `"PTAT"`). On disk it is stored
 * big-endian, but at the C++ API level it is just a `uint32` so the high
 * byte is the first character of the tag string.
 *
 * Maps to:
 *   /home/tharper/code/swg-main/src/engine/shared/library/sharedFoundation/src/shared/Tag.h
 *   `ConvertStringToTag` / `ConvertTagToString`
 *
 * Examples (matching C++ `TAG_*` macros):
 *   tagFromString('FORM')         === 0x464f524d
 *   tagFromString('0003')         === 0x30303033   // four ASCII digit zeros
 *   tagToString(0x464f524d)       === 'FORM'
 *
 * Short strings are space-padded on the right (matching the C++ `TAG3` /
 * `TAG2` / `TAG1` macros which fill with `TAG_DIGIT_SPACE`); strings longer
 * than four characters are truncated. We deliberately match the C++
 * behavior even though it loses information — tags are by definition four
 * characters and the format does not support anything else.
 */

const TAG_LENGTH = 4;
const SPACE = 0x20;

/**
 * Pack a (1-4 character) ASCII string into a 32-bit tag.
 *
 * The first character ends up in the most-significant byte. Strings shorter
 * than 4 characters are padded on the right with ASCII space (0x20),
 * matching the C++ `TAG2` / `TAG3` macros. Strings longer than 4 are
 * truncated.
 *
 * @throws if the string contains a non-ASCII (>0x7f) character — those
 * would round-trip lossily and almost certainly indicate a programmer
 * error (e.g. accidentally passing a UTF-8 byte sequence).
 */
export function tagFromString(s: string): number {
  let result = 0;
  for (let i = 0; i < TAG_LENGTH; ++i) {
    const ch = i < s.length ? s.charCodeAt(i) : SPACE;
    if (ch < 0 || ch > 0x7f) {
      throw new RangeError(
        `tagFromString: character code 0x${ch.toString(16)} at index ${i} of ${JSON.stringify(
          s,
        )} is not 7-bit ASCII`,
      );
    }
    result = ((result << 8) | ch) >>> 0;
  }
  return result >>> 0;
}

/**
 * Unpack a 32-bit tag into a 4-character string.
 *
 * The most-significant byte becomes character index 0. Non-printable bytes
 * are replaced with `'?'` (matching C++ `ConvertTagToString`).
 */
export function tagToString(tag: number): string {
  let out = '';
  const t = tag >>> 0;
  for (let i = 0; i < TAG_LENGTH; ++i) {
    const shift = (TAG_LENGTH - 1 - i) * 8;
    const ch = (t >>> shift) & 0xff;
    out += isPrintable(ch) ? String.fromCharCode(ch) : '?';
  }
  return out;
}

/** True for printable 7-bit ASCII (matches C `isprint`). */
function isPrintable(byte: number): boolean {
  return byte >= 0x20 && byte <= 0x7e;
}

/** The well-known `FORM` tag — the only "this is a container" tag the format defines. */
export const TAG_FORM = tagFromString('FORM');

/**
 * Convenience: same as `tagFromString` but throws on > 4 characters rather
 * than silently truncating. Use this when constructing tags in code that
 * you control — it surfaces typos early.
 */
export function tag(s: string): number {
  if (s.length > TAG_LENGTH) {
    throw new RangeError(`tag: ${JSON.stringify(s)} is more than 4 characters`);
  }
  return tagFromString(s);
}
