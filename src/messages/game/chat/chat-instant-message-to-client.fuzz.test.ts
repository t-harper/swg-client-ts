import fc from 'fast-check';
import { describe, it } from 'vitest';

import { assertWireEqual, fcStdString, fcUnicodeString, roundTrip } from '../../_fuzz-helpers.js';
import { ChatInstantMessageToClient } from './chat-instant-message-to-client.js';

describe('ChatInstantMessageToClient (fuzz)', () => {
  it('round-trips arbitrary (avatar, message, oob) payloads', () => {
    fc.assert(
      fc.property(
        fc.record({
          gameCode: fcStdString({ maxLen: 16 }),
          cluster: fcStdString({ maxLen: 32 }),
          name: fcStdString({ maxLen: 64 }),
        }),
        fcUnicodeString({ maxLen: 256 }),
        fcUnicodeString({ maxLen: 64 }),
        (avatar, msg, oob) => {
          const m = new ChatInstantMessageToClient(avatar, msg, oob);
          const decoded = roundTrip(m, ChatInstantMessageToClient);
          assertWireEqual(
            { avatar: decoded.fromName, msg: decoded.message, oob: decoded.outOfBand },
            { avatar: m.fromName, msg: m.message, oob: m.outOfBand },
          );
        },
      ),
      { numRuns: 100 },
    );
  });
});
