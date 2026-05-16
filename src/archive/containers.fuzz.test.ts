/**
 * Property-based round-trip coverage for the container codecs:
 * AutoArrayCodec, VectorCodec, SetCodec, PairCodec, MapCodec.
 *
 * Exercised against U32 (the most common item codec). The wire layouts
 * are container-agnostic so a single item type is enough to surface
 * count-prefix / iteration bugs.
 */

import fc from 'fast-check';
import { describe, it } from 'vitest';

import {
  assertWireEqual,
  fcI32,
  fcStdString,
  fcU16,
  fcU32,
  roundTripCodec,
} from '../messages/_fuzz-helpers.js';
import { AutoArrayCodec, MapCodec, PairCodec, SetCodec, VectorCodec } from './containers.js';
import { I32, U16, U32 } from './primitives.js';
import { StringCodec } from './string.js';

describe('AutoArrayCodec(U32) (fuzz)', () => {
  const codec = AutoArrayCodec(U32);
  it('round-trips arbitrary U32 arrays', () => {
    fc.assert(
      fc.property(fc.array(fcU32(), { maxLength: 64 }), (xs) => {
        const out = roundTripCodec(xs, codec.encode, codec.decode);
        assertWireEqual(out, xs);
      }),
      { numRuns: 200 },
    );
  });

  it('round-trips an empty array', () => {
    const out = roundTripCodec([], codec.encode, codec.decode);
    assertWireEqual(out, []);
  });

  it('round-trips a max-size short array', () => {
    fc.assert(
      fc.property(fc.array(fcU32(), { minLength: 256, maxLength: 256 }), (xs) => {
        const out = roundTripCodec(xs, codec.encode, codec.decode);
        assertWireEqual(out, xs);
      }),
      { numRuns: 20 },
    );
  });
});

describe('AutoArrayCodec(StringCodec) (fuzz)', () => {
  const codec = AutoArrayCodec(StringCodec);
  it('round-trips arrays of arbitrary strings', () => {
    fc.assert(
      fc.property(fc.array(fcStdString({ maxLen: 64 }), { maxLength: 32 }), (xs) => {
        const out = roundTripCodec(xs, codec.encode, codec.decode);
        assertWireEqual(out, xs);
      }),
      { numRuns: 100 },
    );
  });
});

describe('VectorCodec(I32) (fuzz)', () => {
  const codec = VectorCodec(I32);
  it('round-trips arbitrary I32 vectors', () => {
    fc.assert(
      fc.property(fc.array(fcI32(), { maxLength: 64 }), (xs) => {
        const out = roundTripCodec(xs, codec.encode, codec.decode);
        assertWireEqual(out, xs);
      }),
      { numRuns: 200 },
    );
  });
});

describe('SetCodec(StringCodec) (fuzz)', () => {
  const codec = SetCodec(StringCodec);
  it('round-trips arbitrary string sets', () => {
    fc.assert(
      fc.property(fc.uniqueArray(fcStdString({ maxLen: 32 }), { maxLength: 16 }), (xs) => {
        const s = new Set(xs);
        const out = roundTripCodec(s, codec.encode, codec.decode);
        assertWireEqual(out, s);
      }),
      { numRuns: 100 },
    );
  });

  it('round-trips an empty set', () => {
    const s = new Set<string>();
    const out = roundTripCodec(s, codec.encode, codec.decode);
    assertWireEqual(out, s);
  });
});

describe('PairCodec(U16, StringCodec) (fuzz)', () => {
  const codec = PairCodec(U16, StringCodec);
  it('round-trips arbitrary [u16, string] pairs', () => {
    fc.assert(
      fc.property(fcU16(), fcStdString({ maxLen: 32 }), (a, b) => {
        const pair: [number, string] = [a, b];
        const out = roundTripCodec(pair, codec.encode, codec.decode);
        assertWireEqual(out, pair);
      }),
      { numRuns: 200 },
    );
  });
});

describe('MapCodec(StringCodec, U32) (fuzz)', () => {
  const codec = MapCodec(StringCodec, U32);
  it('round-trips arbitrary string -> u32 maps', () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(fc.tuple(fcStdString({ maxLen: 32 }), fcU32()), {
          maxLength: 16,
          selector: (t) => t[0],
        }),
        (entries) => {
          const m = new Map(entries);
          const out = roundTripCodec(m, codec.encode, codec.decode);
          assertWireEqual(out, m);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('round-trips an empty map', () => {
    const m = new Map<string, number>();
    const out = roundTripCodec(m, codec.encode, codec.decode);
    assertWireEqual(out, m);
  });
});
