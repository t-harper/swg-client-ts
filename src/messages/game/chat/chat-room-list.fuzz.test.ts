import fc from 'fast-check';
import { describe, it } from 'vitest';

import {
  assertWireEqual,
  fcStdString,
  fcU8,
  fcU32,
  fcUnicodeString,
  roundTrip,
} from '../../_fuzz-helpers.js';
import type { ChatAvatarId } from './chat-avatar-id.js';
import type { ChatRoomData } from './chat-room-data.js';
import { ChatRoomList } from './chat-room-list.js';

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

describe('ChatRoomList (fuzz)', () => {
  it('round-trips arbitrary room lists', () => {
    fc.assert(
      fc.property(fc.array(fcRoomData(), { maxLength: 8 }), (rooms) => {
        const m = new ChatRoomList(rooms);
        const decoded = roundTrip(m, ChatRoomList);
        assertWireEqual(decoded.roomData, m.roomData);
      }),
      { numRuns: 50 },
    );
  });

  it('round-trips the empty room list', () => {
    const m = new ChatRoomList([]);
    const decoded = roundTrip(m, ChatRoomList);
    assertWireEqual(decoded.roomData, []);
  });
});
