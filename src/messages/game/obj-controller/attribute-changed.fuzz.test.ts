import fc from 'fast-check';
import { describe, it } from 'vitest';

import { assertWireEqual, fcI32, fcNetworkId, roundTripCodec } from '../../_fuzz-helpers.js';
import { AttributeChangedDecoder } from './attribute-changed.js';

describe('AttributeChanged (fuzz)', () => {
  it('round-trips arbitrary (delta, source) trailers', () => {
    fc.assert(
      fc.property(fcI32(), fcNetworkId(), (delta, source) => {
        const data = { delta, source };
        const out = roundTripCodec(
          data,
          AttributeChangedDecoder.encode,
          AttributeChangedDecoder.decode,
        );
        assertWireEqual(out, data);
      }),
      { numRuns: 200 },
    );
  });
});
