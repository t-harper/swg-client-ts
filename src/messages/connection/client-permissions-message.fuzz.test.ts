import fc from 'fast-check';
import { describe, it } from 'vitest';

import { assertWireEqual, roundTrip } from '../_fuzz-helpers.js';
import { ClientPermissionsMessage } from './client-permissions-message.js';

describe('ClientPermissionsMessage (fuzz)', () => {
  it('round-trips arbitrary boolean bit patterns', () => {
    fc.assert(
      fc.property(
        fc.boolean(),
        fc.boolean(),
        fc.boolean(),
        fc.boolean(),
        fc.boolean(),
        (a, b, c, d, e) => {
          const m = new ClientPermissionsMessage(a, b, c, d, e);
          const decoded = roundTrip(m, ClientPermissionsMessage);
          assertWireEqual(
            {
              canLogin: decoded.canLogin,
              canCreateRegularCharacter: decoded.canCreateRegularCharacter,
              canCreateJediCharacter: decoded.canCreateJediCharacter,
              canSkipTutorial: decoded.canSkipTutorial,
              isAdmin: decoded.isAdmin,
            },
            {
              canLogin: m.canLogin,
              canCreateRegularCharacter: m.canCreateRegularCharacter,
              canCreateJediCharacter: m.canCreateJediCharacter,
              canSkipTutorial: m.canSkipTutorial,
              isAdmin: m.isAdmin,
            },
          );
        },
      ),
      { numRuns: 100 },
    );
  });
});
