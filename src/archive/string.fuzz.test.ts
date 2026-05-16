/**
 * Property-based round-trip coverage for StringCodec — std::string
 * (UTF-8 bytes with a u16 LE length prefix; bumps to u32 above 65534).
 */

import fc from 'fast-check';
import { describe, it } from 'vitest';

import { assertWireEqual, fcStdString, roundTripCodec } from '../messages/_fuzz-helpers.js';
import { StringCodec } from './string.js';

describe('StringCodec (fuzz)', () => {
  it('round-trips short strings', () => {
    fc.assert(
      fc.property(fcStdString({ maxLen: 256 }), (s) => {
        const out = roundTripCodec(s, StringCodec.encode, StringCodec.decode);
        assertWireEqual(out, s);
      }),
      { numRuns: 200 },
    );
  });

  it('round-trips the empty string', () => {
    const out = roundTripCodec('', StringCodec.encode, StringCodec.decode);
    assertWireEqual(out, '');
  });

  it('round-trips single-byte ASCII edge cases', () => {
    for (const s of ['a', 'z', '0', ' ', '\0', '\xff']) {
      const out = roundTripCodec(s, StringCodec.encode, StringCodec.decode);
      assertWireEqual(out, s);
    }
  });

  it('round-trips multi-byte UTF-8 (emoji and CJK)', () => {
    for (const s of ['hello', 'cafe', 'cafe-resume', '中文', '日本語']) {
      const out = roundTripCodec(s, StringCodec.encode, StringCodec.decode);
      assertWireEqual(out, s);
    }
  });

  it('round-trips medium-length strings (under the u16 inline boundary)', () => {
    fc.assert(
      fc.property(fcStdString({ maxLen: 1000 }), (s) => {
        const out = roundTripCodec(s, StringCodec.encode, StringCodec.decode);
        assertWireEqual(out, s);
      }),
      { numRuns: 50 },
    );
  });
});
