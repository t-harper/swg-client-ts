/**
 * Property-based round-trip coverage for ChatAvatarId — three sequential
 * std::strings (gameCode, cluster, name).
 */

import fc from 'fast-check';
import { describe, it } from 'vitest';

import { assertWireEqual, fcStdString, roundTripCodec } from '../../_fuzz-helpers.js';
import { ChatAvatarIdCodec } from './chat-avatar-id.js';

describe('ChatAvatarId (fuzz)', () => {
  it('round-trips any (gameCode, cluster, name) triple', () => {
    fc.assert(
      fc.property(
        fcStdString({ maxLen: 16 }),
        fcStdString({ maxLen: 32 }),
        fcStdString({ maxLen: 64 }),
        (gameCode, cluster, name) => {
          const id = { gameCode, cluster, name };
          const out = roundTripCodec(id, ChatAvatarIdCodec.encode, ChatAvatarIdCodec.decode);
          assertWireEqual(out, id);
        },
      ),
      { numRuns: 200 },
    );
  });
});
