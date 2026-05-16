import fc from 'fast-check';
import { describe, it } from 'vitest';

import { assertWireEqual, fcF32, fcNetworkId, roundTripCodec } from '../../_fuzz-helpers.js';
import { SitOnObjectDecoder } from './sit-on-object.js';

describe('SitOnObject (fuzz)', () => {
  it('round-trips arbitrary (chairCellId, chairPosition) trailers', () => {
    fc.assert(
      fc.property(
        fcNetworkId(),
        fc.record({ x: fcF32(), y: fcF32(), z: fcF32() }),
        (chairCellId, chairPosition) => {
          const data = { chairCellId, chairPosition };
          const out = roundTripCodec(data, SitOnObjectDecoder.encode, SitOnObjectDecoder.decode);
          assertWireEqual(out, data);
        },
      ),
      { numRuns: 200 },
    );
  });
});
