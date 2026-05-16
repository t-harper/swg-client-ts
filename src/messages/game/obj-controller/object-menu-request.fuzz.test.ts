import fc from 'fast-check';
import { describe, it } from 'vitest';

import {
  assertWireEqual,
  fcNetworkId,
  fcU8,
  fcU16,
  fcUnicodeString,
  roundTripCodec,
} from '../../_fuzz-helpers.js';
import { type ObjectMenuItem, ObjectMenuRequestDecoder } from './object-menu-request.js';

const fcMenuItem = (): fc.Arbitrary<ObjectMenuItem> =>
  fc.record({
    id: fcU8(),
    parent: fcU8(),
    menuItemType: fcU16(),
    flags: fcU8(),
    label: fcUnicodeString({ maxLen: 32 }),
  });

describe('ObjectMenuRequest (fuzz)', () => {
  it('round-trips arbitrary menus', () => {
    fc.assert(
      fc.property(
        fc.record({
          targetId: fcNetworkId(),
          requestorId: fcNetworkId(),
          items: fc.array(fcMenuItem(), { maxLength: 16 }),
          sequence: fcU8(),
        }),
        (data) => {
          const out = roundTripCodec(
            data,
            ObjectMenuRequestDecoder.encode,
            ObjectMenuRequestDecoder.decode,
          );
          assertWireEqual(out, data);
        },
      ),
      { numRuns: 100 },
    );
  });
});
