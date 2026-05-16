import fc from 'fast-check';
import { describe, it } from 'vitest';

import { assertWireEqual, fcNetworkId, fcStdString, roundTrip } from '../_fuzz-helpers.js';
import { ClientOpenContainerMessage } from './client-open-container.js';

describe('ClientOpenContainerMessage (fuzz)', () => {
  it('round-trips arbitrary (containerId, slot) pairs', () => {
    fc.assert(
      fc.property(fcNetworkId(), fcStdString({ maxLen: 32 }), (id, slot) => {
        const m = new ClientOpenContainerMessage(id, slot);
        const decoded = roundTrip(m, ClientOpenContainerMessage);
        assertWireEqual(
          { containerId: decoded.containerId, slot: decoded.slot },
          { containerId: m.containerId, slot: m.slot },
        );
      }),
      { numRuns: 200 },
    );
  });
});
