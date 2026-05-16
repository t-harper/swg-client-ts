import fc from 'fast-check';
import { describe, it } from 'vitest';

import { assertWireEqual, fcU32, roundTripCodec } from '../../_fuzz-helpers.js';
import { MoodChangeDecoder } from './mood-change.js';

describe('MoodChange (fuzz)', () => {
  it('round-trips arbitrary u32 mood values', () => {
    fc.assert(
      fc.property(fcU32(), (mood) => {
        const data = { mood };
        const out = roundTripCodec(data, MoodChangeDecoder.encode, MoodChangeDecoder.decode);
        assertWireEqual(out, data);
      }),
      { numRuns: 200 },
    );
  });
});
