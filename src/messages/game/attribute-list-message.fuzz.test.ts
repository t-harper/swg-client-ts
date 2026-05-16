import fc from 'fast-check';
import { describe, it } from 'vitest';

import {
  assertWireEqual,
  fcI32,
  fcNetworkId,
  fcStdString,
  fcUnicodeString,
  roundTrip,
} from '../_fuzz-helpers.js';
import { AttributeListMessage, type AttributePair } from './attribute-list-message.js';

const fcPair = (): fc.Arbitrary<AttributePair> =>
  fc.record({
    key: fcStdString({ maxLen: 32 }),
    value: fcUnicodeString({ maxLen: 64 }),
  });

describe('AttributeListMessage (fuzz)', () => {
  it('round-trips arbitrary attribute lists', () => {
    fc.assert(
      fc.property(
        fcNetworkId(),
        fcStdString({ maxLen: 32 }),
        fc.array(fcPair(), { maxLength: 16 }),
        fcI32(),
        (id, name, pairs, rev) => {
          const m = new AttributeListMessage(id, name, pairs, rev);
          const decoded = roundTrip(m, AttributeListMessage);
          assertWireEqual(
            {
              networkId: decoded.networkId,
              staticItemName: decoded.staticItemName,
              data: decoded.data,
              revision: decoded.revision,
            },
            {
              networkId: m.networkId,
              staticItemName: m.staticItemName,
              data: m.data,
              revision: m.revision,
            },
          );
        },
      ),
      { numRuns: 100 },
    );
  });
});
