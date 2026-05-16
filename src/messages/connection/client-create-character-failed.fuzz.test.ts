import fc from 'fast-check';
import { describe, it } from 'vitest';

import {
  assertWireEqual,
  fcStdString,
  fcU32,
  fcUnicodeString,
  roundTrip,
} from '../_fuzz-helpers.js';
import { ClientCreateCharacterFailed, type StringId } from './client-create-character-failed.js';

const fcStringId = (): fc.Arbitrary<StringId> =>
  fc.record({
    table: fcStdString({ maxLen: 32 }),
    textIndex: fcU32(),
    name: fcStdString({ maxLen: 64 }),
  });

describe('ClientCreateCharacterFailed (fuzz)', () => {
  it('round-trips arbitrary (name, StringId) payloads', () => {
    fc.assert(
      fc.property(fcUnicodeString({ maxLen: 32 }), fcStringId(), (name, sid) => {
        const m = new ClientCreateCharacterFailed(name, sid);
        const decoded = roundTrip(m, ClientCreateCharacterFailed);
        assertWireEqual(
          { name: decoded.name, err: decoded.errorMessage },
          { name: m.name, err: m.errorMessage },
        );
      }),
      { numRuns: 200 },
    );
  });
});
