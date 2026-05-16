import fc from 'fast-check';
import { describe, it } from 'vitest';

import { assertWireEqual, fcStdString, roundTrip } from '../_fuzz-helpers.js';
import { LoginIncorrectClientId } from './login-incorrect-client-id.js';

describe('LoginIncorrectClientId (fuzz)', () => {
  it('round-trips arbitrary (serverId, serverApplicationVersion) pairs', () => {
    fc.assert(
      fc.property(fcStdString({ maxLen: 32 }), fcStdString({ maxLen: 32 }), (serverId, version) => {
        const m = new LoginIncorrectClientId(serverId, version);
        const decoded = roundTrip(m, LoginIncorrectClientId);
        assertWireEqual(
          { id: decoded.serverId, ver: decoded.serverApplicationVersion },
          { id: m.serverId, ver: m.serverApplicationVersion },
        );
      }),
      { numRuns: 200 },
    );
  });
});
