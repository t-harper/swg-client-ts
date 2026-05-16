import fc from 'fast-check';
import { describe, it } from 'vitest';

import { assertWireEqual, fcNetworkId, roundTrip } from '../_fuzz-helpers.js';
import { SelectCharacter } from './select-character.js';

describe('SelectCharacter (fuzz)', () => {
  it('round-trips arbitrary NetworkId values', () => {
    fc.assert(
      fc.property(fcNetworkId(), (id) => {
        const m = new SelectCharacter(id);
        const decoded = roundTrip(m, SelectCharacter);
        assertWireEqual(decoded.networkId, id);
      }),
      { numRuns: 200 },
    );
  });
});
