import fc from 'fast-check';
import { describe, it } from 'vitest';

import {
  assertWireEqual,
  fcStdString,
  fcU32,
  fcUnicodeString,
  roundTrip,
} from '../../_fuzz-helpers.js';
import {
  ChatPersistentMessageToServer,
  PERSISTENT_MESSAGE_MAX_SIZE,
} from './chat-persistent-message-to-server.js';

describe('ChatPersistentMessageToServer (fuzz)', () => {
  it('round-trips arbitrary mail payloads (body capped at MAX_MESSAGE_SIZE)', () => {
    fc.assert(
      fc.property(
        fcU32(),
        fc.record({
          gameCode: fcStdString({ maxLen: 16 }),
          cluster: fcStdString({ maxLen: 32 }),
          name: fcStdString({ maxLen: 64 }),
        }),
        fcUnicodeString({ maxLen: 128 }),
        // Bound the body well under MAX_MESSAGE_SIZE so generators don't
        // hit the constructor's truncation path; that path is exercised by
        // the existing golden test in chat-persistent-message-to-server.test.ts.
        fcUnicodeString({ maxLen: Math.min(512, PERSISTENT_MESSAGE_MAX_SIZE) }),
        fcUnicodeString({ maxLen: 32 }),
        (seq, avatar, subject, body, oob) => {
          const m = new ChatPersistentMessageToServer(seq, avatar, subject, body, oob);
          const decoded = roundTrip(m, ChatPersistentMessageToServer);
          assertWireEqual(
            {
              sequence: decoded.sequence,
              toCharacterName: decoded.toCharacterName,
              subject: decoded.subject,
              message: decoded.message,
              outOfBand: decoded.outOfBand,
            },
            {
              sequence: m.sequence,
              toCharacterName: m.toCharacterName,
              subject: m.subject,
              message: m.message,
              outOfBand: m.outOfBand,
            },
          );
        },
      ),
      { numRuns: 50 },
    );
  });
});
