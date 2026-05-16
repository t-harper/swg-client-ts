/**
 * Property-based round-trip coverage for HeartBeat — degenerate
 * empty-body case. The fuzz "input" is constant because the message
 * carries no payload; the property just exercises the framework.
 */

import fc from 'fast-check';
import { describe, it } from 'vitest';

import { assertWireEqual, roundTrip } from '../_fuzz-helpers.js';
import { HeartBeat } from './heart-beat.js';

describe('HeartBeat (fuzz)', () => {
  it('round-trips every encode -> decode', () => {
    fc.assert(
      fc.property(fc.constant(new HeartBeat()), (m) => {
        const decoded = roundTrip(m, HeartBeat);
        assertWireEqual(decoded, m);
      }),
      { numRuns: 50 },
    );
  });
});
