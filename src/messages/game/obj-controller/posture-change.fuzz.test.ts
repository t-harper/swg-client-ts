import fc from 'fast-check';
import { describe, it } from 'vitest';

import { assertWireEqual, fcU8, roundTripCodec } from '../../_fuzz-helpers.js';
import { PostureChangeDecoder } from './posture-change.js';

describe('PostureChange (fuzz)', () => {
  it('round-trips arbitrary (posture, isClientImmediate) trailers', () => {
    fc.assert(
      fc.property(fcU8(), fc.boolean(), (posture, isClientImmediate) => {
        const data = { posture, isClientImmediate };
        const out = roundTripCodec(data, PostureChangeDecoder.encode, PostureChangeDecoder.decode);
        assertWireEqual(out, data);
      }),
      { numRuns: 200 },
    );
  });
});
