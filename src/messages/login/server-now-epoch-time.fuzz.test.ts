import fc from 'fast-check';
import { describe, it } from 'vitest';

import { assertWireEqual, fcI32, roundTrip } from '../_fuzz-helpers.js';
import { ServerNowEpochTime } from './server-now-epoch-time.js';

describe('ServerNowEpochTime (fuzz)', () => {
  it('round-trips arbitrary i32 epoch values', () => {
    fc.assert(
      fc.property(fcI32(), (v) => {
        const m = new ServerNowEpochTime(v);
        const decoded = roundTrip(m, ServerNowEpochTime);
        assertWireEqual(decoded.value, v);
      }),
      { numRuns: 200 },
    );
  });
});
