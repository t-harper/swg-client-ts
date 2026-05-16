import fc from 'fast-check';
import { describe, it } from 'vitest';

import { assertWireEqual, fcNetworkId, roundTrip } from '../_fuzz-helpers.js';
import { ClientCreateCharacterSuccess } from './client-create-character-success.js';

describe('ClientCreateCharacterSuccess (fuzz)', () => {
  it('round-trips arbitrary NetworkId values', () => {
    fc.assert(
      fc.property(fcNetworkId(), (id) => {
        const m = new ClientCreateCharacterSuccess(id);
        const decoded = roundTrip(m, ClientCreateCharacterSuccess);
        assertWireEqual(decoded.networkId, id);
      }),
      { numRuns: 200 },
    );
  });
});
