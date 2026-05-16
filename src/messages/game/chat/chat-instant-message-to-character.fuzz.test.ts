import fc from 'fast-check';
import { describe, it } from 'vitest';

import {
  assertWireEqual,
  fcStdString,
  fcU32,
  fcUnicodeString,
  roundTrip,
} from '../../_fuzz-helpers.js';
import { ChatInstantMessageToCharacter } from './chat-instant-message-to-character.js';

describe('ChatInstantMessageToCharacter (fuzz)', () => {
  it('round-trips arbitrary (avatar, message, oob, sequence) payloads', () => {
    fc.assert(
      fc.property(
        fc.record({
          gameCode: fcStdString({ maxLen: 16 }),
          cluster: fcStdString({ maxLen: 32 }),
          name: fcStdString({ maxLen: 64 }),
        }),
        fcUnicodeString({ maxLen: 256 }),
        fcUnicodeString({ maxLen: 64 }),
        fcU32(),
        (avatar, msg, oob, seq) => {
          const m = new ChatInstantMessageToCharacter(avatar, msg, oob, seq);
          const decoded = roundTrip(m, ChatInstantMessageToCharacter);
          assertWireEqual(
            {
              avatar: decoded.characterName,
              msg: decoded.message,
              oob: decoded.outOfBand,
              seq: decoded.sequence,
            },
            { avatar: m.characterName, msg: m.message, oob: m.outOfBand, seq: m.sequence },
          );
        },
      ),
      { numRuns: 100 },
    );
  });
});
