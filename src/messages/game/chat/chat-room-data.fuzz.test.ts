import fc from 'fast-check';
import { describe, it } from 'vitest';

import {
  assertWireEqual,
  fcStdString,
  fcU8,
  fcU32,
  fcUnicodeString,
  roundTripCodec,
} from '../../_fuzz-helpers.js';
import type { ChatAvatarId } from './chat-avatar-id.js';
import { type ChatRoomData, ChatRoomDataCodec } from './chat-room-data.js';

const fcAvatar = (): fc.Arbitrary<ChatAvatarId> =>
  fc.record({
    gameCode: fcStdString({ maxLen: 16 }),
    cluster: fcStdString({ maxLen: 32 }),
    name: fcStdString({ maxLen: 64 }),
  });

const fcRoomData = (): fc.Arbitrary<ChatRoomData> =>
  fc.record({
    id: fcU32(),
    roomType: fcU32(),
    moderated: fcU8(),
    path: fcStdString({ maxLen: 64 }),
    owner: fcAvatar(),
    creator: fcAvatar(),
    title: fcUnicodeString({ maxLen: 64 }),
    moderators: fc.array(fcAvatar(), { maxLength: 4 }),
    invitees: fc.array(fcAvatar(), { maxLength: 4 }),
  });

describe('ChatRoomDataCodec (fuzz)', () => {
  it('round-trips arbitrary ChatRoomData', () => {
    fc.assert(
      fc.property(fcRoomData(), (data) => {
        const out = roundTripCodec(data, ChatRoomDataCodec.encode, ChatRoomDataCodec.decode);
        assertWireEqual(out, data);
      }),
      { numRuns: 100 },
    );
  });
});
