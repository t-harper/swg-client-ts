import fc from 'fast-check';
import { describe, it } from 'vitest';

import { assertWireEqual, fcStdString, roundTrip } from '../_fuzz-helpers.js';
import { ErrorMessage } from './error-message.js';

describe('ErrorMessage (fuzz)', () => {
  it('round-trips arbitrary (errorName, description, fatal) triples', () => {
    fc.assert(
      fc.property(
        fcStdString({ maxLen: 64 }),
        fcStdString({ maxLen: 256 }),
        fc.boolean(),
        (name, desc, fatal) => {
          const m = new ErrorMessage(name, desc, fatal);
          const decoded = roundTrip(m, ErrorMessage);
          assertWireEqual(
            { name: decoded.errorName, desc: decoded.description, fatal: decoded.fatal },
            { name: m.errorName, desc: m.description, fatal: m.fatal },
          );
        },
      ),
      { numRuns: 200 },
    );
  });
});
