/**
 * Property-based round-trip coverage for UnicodeStringCodec — UTF-16 LE
 * with a u32 char-count prefix. SWG uses fixed-width 16-bit code units
 * (no surrogate-pair handling) so generated strings stay in the BMP and
 * skip the surrogate range.
 */

import fc from 'fast-check';
import { describe, it } from 'vitest';

import { assertWireEqual, fcUnicodeString, roundTripCodec } from '../messages/_fuzz-helpers.js';
import { UnicodeStringCodec } from './unicode-string.js';

describe('UnicodeStringCodec (fuzz)', () => {
  it('round-trips short BMP strings', () => {
    fc.assert(
      fc.property(fcUnicodeString({ maxLen: 128 }), (s) => {
        const out = roundTripCodec(s, UnicodeStringCodec.encode, UnicodeStringCodec.decode);
        assertWireEqual(out, s);
      }),
      { numRuns: 200 },
    );
  });

  it('round-trips the empty string', () => {
    const out = roundTripCodec('', UnicodeStringCodec.encode, UnicodeStringCodec.decode);
    assertWireEqual(out, '');
  });

  it('round-trips ASCII printable boundary chars', () => {
    for (const s of ['hello', 'a', '0', ' ', '\x7f', ' ']) {
      const out = roundTripCodec(s, UnicodeStringCodec.encode, UnicodeStringCodec.decode);
      assertWireEqual(out, s);
    }
  });

  it('round-trips characters bordering the surrogate range', () => {
    // U+D7FF is the last char before the surrogate range starts at U+D800.
    // U+E000 is the first char after the surrogate range ends.
    const left = String.fromCharCode(0xd7ff);
    const right = String.fromCharCode(0xe000);
    for (const s of [left, right, left + right]) {
      const out = roundTripCodec(s, UnicodeStringCodec.encode, UnicodeStringCodec.decode);
      assertWireEqual(out, s);
    }
  });

  it('round-trips medium-length strings', () => {
    fc.assert(
      fc.property(fcUnicodeString({ maxLen: 500 }), (s) => {
        const out = roundTripCodec(s, UnicodeStringCodec.encode, UnicodeStringCodec.decode);
        assertWireEqual(out, s);
      }),
      { numRuns: 50 },
    );
  });
});
