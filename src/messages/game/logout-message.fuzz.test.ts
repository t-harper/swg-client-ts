import fc from 'fast-check';
import { describe, it } from 'vitest';

import { assertWireEqual, roundTrip } from '../_fuzz-helpers.js';
import { LogoutMessage } from './logout-message.js';

describe('LogoutMessage (fuzz)', () => {
  it('round-trips every encode -> decode (empty body)', () => {
    fc.assert(
      fc.property(fc.constant(new LogoutMessage()), (m) => {
        const decoded = roundTrip(m, LogoutMessage);
        assertWireEqual(decoded, m);
      }),
      { numRuns: 50 },
    );
  });
});
