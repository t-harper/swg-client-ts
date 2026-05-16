import fc from 'fast-check';
import { describe, it } from 'vitest';

import { assertWireEqual, fcStdString, fcU32, roundTrip } from '../_fuzz-helpers.js';
import { LoginClientToken } from './login-client-token.js';

describe('LoginClientToken (fuzz)', () => {
  it('round-trips arbitrary (token, stationId, username) triples', () => {
    fc.assert(
      fc.property(
        fc.uint8Array({ maxLength: 256 }),
        fcU32(),
        fcStdString({ maxLen: 64 }),
        (token, stationId, username) => {
          const m = new LoginClientToken(token, stationId, username);
          const decoded = roundTrip(m, LoginClientToken);
          assertWireEqual(
            {
              token: decoded.token,
              stationId: decoded.stationId,
              username: decoded.username,
            },
            { token: m.token, stationId: m.stationId, username: m.username },
          );
        },
      ),
      { numRuns: 200 },
    );
  });

  it('round-trips an empty token', () => {
    const m = new LoginClientToken(new Uint8Array(0), 0, '');
    const decoded = roundTrip(m, LoginClientToken);
    assertWireEqual(decoded.token, new Uint8Array(0));
  });
});
