/**
 * Property-based round-trip coverage for TransformCodec (28 bytes:
 * Quaternion[xyzw] + Vector[xyz], all f32 LE), Vector3Codec, and
 * QuaternionCodec.
 *
 * Note: QuaternionCodec.decode special-cases NaN inputs (returns the
 * identity quaternion). We generate non-NaN floats so the round-trip
 * equality holds.
 */

import fc from 'fast-check';
import { describe, it } from 'vitest';

import { assertWireEqual, fcF32, roundTripCodec } from '../messages/_fuzz-helpers.js';
import { QuaternionCodec, TransformCodec, Vector3Codec } from './transform.js';

describe('Vector3Codec (fuzz)', () => {
  it('round-trips arbitrary {x,y,z} f32 triples', () => {
    fc.assert(
      fc.property(fcF32(), fcF32(), fcF32(), (x, y, z) => {
        const v = { x, y, z };
        const out = roundTripCodec(v, Vector3Codec.encode, Vector3Codec.decode);
        assertWireEqual(out, v);
      }),
      { numRuns: 200 },
    );
  });
});

describe('QuaternionCodec (fuzz)', () => {
  it('round-trips arbitrary {x,y,z,w} f32 quads (non-NaN)', () => {
    fc.assert(
      fc.property(fcF32(), fcF32(), fcF32(), fcF32(), (x, y, z, w) => {
        const q = { x, y, z, w };
        const out = roundTripCodec(q, QuaternionCodec.encode, QuaternionCodec.decode);
        assertWireEqual(out, q);
      }),
      { numRuns: 200 },
    );
  });
});

describe('TransformCodec (fuzz)', () => {
  it('round-trips arbitrary Transform (Quaternion + Vector3)', () => {
    fc.assert(
      fc.property(
        fc.record({
          rotation: fc.record({ x: fcF32(), y: fcF32(), z: fcF32(), w: fcF32() }),
          position: fc.record({ x: fcF32(), y: fcF32(), z: fcF32() }),
        }),
        (t) => {
          const out = roundTripCodec(t, TransformCodec.encode, TransformCodec.decode);
          assertWireEqual(out, t);
        },
      ),
      { numRuns: 200 },
    );
  });
});
