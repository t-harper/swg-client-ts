import fc from 'fast-check';
import { describe, it } from 'vitest';

import { assertWireEqual, fcI32, roundTrip } from '../_fuzz-helpers.js';
import { StationIdHasJediSlot } from './station-id-has-jedi-slot.js';

describe('StationIdHasJediSlot (fuzz)', () => {
  it('round-trips arbitrary i32 values', () => {
    fc.assert(
      fc.property(fcI32(), (v) => {
        const m = new StationIdHasJediSlot(v);
        const decoded = roundTrip(m, StationIdHasJediSlot);
        assertWireEqual(decoded.value, v);
      }),
      { numRuns: 200 },
    );
  });
});
