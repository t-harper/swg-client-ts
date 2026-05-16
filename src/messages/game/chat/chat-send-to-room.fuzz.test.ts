import fc from 'fast-check';
import { describe, it } from 'vitest';

import { assertWireEqual, fcU32, fcUnicodeString, roundTrip } from '../../_fuzz-helpers.js';
import { ChatSendToRoom } from './chat-send-to-room.js';

describe('ChatSendToRoom (fuzz)', () => {
  it('round-trips arbitrary (sequence, roomId, message, oob) payloads', () => {
    fc.assert(
      fc.property(
        fcU32(),
        fcU32(),
        fcUnicodeString({ maxLen: 256 }),
        fcUnicodeString({ maxLen: 64 }),
        (seq, roomId, msg, oob) => {
          const m = new ChatSendToRoom(seq, roomId, msg, oob);
          const decoded = roundTrip(m, ChatSendToRoom);
          assertWireEqual(
            {
              sequence: decoded.sequence,
              roomId: decoded.roomId,
              message: decoded.message,
              outOfBand: decoded.outOfBand,
            },
            { sequence: m.sequence, roomId: m.roomId, message: m.message, outOfBand: m.outOfBand },
          );
        },
      ),
      { numRuns: 100 },
    );
  });
});
