import fc from 'fast-check';
import { describe, it } from 'vitest';

import { assertWireEqual, roundTrip } from '../../_fuzz-helpers.js';
import { ChatRequestRoomList } from './chat-request-room-list.js';

describe('ChatRequestRoomList (fuzz)', () => {
  it('round-trips every encode -> decode (empty body)', () => {
    fc.assert(
      fc.property(fc.constant(new ChatRequestRoomList()), (m) => {
        const decoded = roundTrip(m, ChatRequestRoomList);
        assertWireEqual(decoded, m);
      }),
      { numRuns: 50 },
    );
  });
});
