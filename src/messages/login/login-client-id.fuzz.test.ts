import fc from 'fast-check';
import { describe, it } from 'vitest';

import { assertWireEqual, fcStdString, roundTrip } from '../_fuzz-helpers.js';
import { LoginClientId } from './login-client-id.js';

describe('LoginClientId (fuzz)', () => {
  it('round-trips arbitrary (id, key, version) triples', () => {
    fc.assert(
      fc.property(
        fcStdString({ maxLen: 64 }),
        fcStdString({ maxLen: 128 }),
        fcStdString({ maxLen: 32 }),
        (id, key, version) => {
          const m = new LoginClientId(id, key, version);
          const decoded = roundTrip(m, LoginClientId);
          assertWireEqual(
            { id: decoded.id, key: decoded.key, version: decoded.version },
            { id: m.id, key: m.key, version: m.version },
          );
        },
      ),
      { numRuns: 200 },
    );
  });
});
