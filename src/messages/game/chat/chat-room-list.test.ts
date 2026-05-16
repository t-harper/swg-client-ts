import { describe, expect, it } from 'vitest';

import { encodeMessage, parseHeader } from '../../base.js';
import { messageRegistry } from '../../registry.js';
import { chatAvatarId } from './chat-avatar-id.js';
import { type ChatRoomData, ChatRoomType } from './chat-room-data.js';
import { ChatRoomList } from './chat-room-list.js';

import './chat-room-list.js';

describe('ChatRoomList', () => {
  it('has the expected metadata', () => {
    expect(ChatRoomList.messageName).toBe('ChatRoomList');
    expect(ChatRoomList.varCount).toBe(2);
    expect(ChatRoomList.typeCrc).toBeGreaterThan(0);
  });

  it('round-trips an empty list (just the AutoArray u32 count = 0)', () => {
    const bytes = encodeMessage(new ChatRoomList([]));
    // Header (6) + AutoArray count u32 (4) = 10
    expect(bytes.length).toBe(10);
    expect(bytes[0]).toBe(0x02);
    expect(bytes[1]).toBe(0x00);

    const { typeCrc, payload } = parseHeader(bytes);
    const decoder = messageRegistry.getByCrc(typeCrc);
    if (!decoder) throw new Error('decoder missing');
    const decoded = decoder.decodePayload(payload);
    expect(decoded).toBeInstanceOf(ChatRoomList);
    if (!(decoded instanceof ChatRoomList)) throw new Error('typeguard');
    expect(decoded.roomData).toEqual([]);
  });

  it('round-trips a single room with two moderators and one invitee', () => {
    const room: ChatRoomData = {
      id: 7,
      roomType: ChatRoomType.Public,
      moderated: 1,
      path: 'SWG.swg.Galaxy',
      owner: chatAvatarId('han', 'swg', 'SWG'),
      creator: chatAvatarId('admin', 'swg', 'SWG'),
      title: 'Galactic chat',
      moderators: [chatAvatarId('mod1', 'swg', 'SWG'), chatAvatarId('mod2', 'swg', 'SWG')],
      invitees: [chatAvatarId('vip', 'swg', 'SWG')],
    };
    const bytes = encodeMessage(new ChatRoomList([room]));

    const { payload } = parseHeader(bytes);
    const decoded = ChatRoomList.decodePayload(payload);
    expect(decoded.roomData.length).toBe(1);
    const r = decoded.roomData[0];
    if (r === undefined) throw new Error('expected single room');
    expect(r.id).toBe(7);
    expect(r.roomType).toBe(ChatRoomType.Public);
    expect(r.moderated).toBe(1);
    expect(r.path).toBe('SWG.swg.Galaxy');
    expect(r.title).toBe('Galactic chat');
    expect(r.owner.name).toBe('han');
    expect(r.creator.name).toBe('admin');
    expect(r.moderators.length).toBe(2);
    expect(r.moderators[0]?.name).toBe('mod1');
    expect(r.moderators[1]?.name).toBe('mod2');
    expect(r.invitees.length).toBe(1);
    expect(r.invitees[0]?.name).toBe('vip');
  });

  it('produces the documented field order inside one ChatRoomData', () => {
    // Smallest possible room: id=1, type=0, moderated=0, empty strings/avatars/arrays.
    const room: ChatRoomData = {
      id: 1,
      roomType: 0,
      moderated: 0,
      path: '',
      owner: chatAvatarId(''),
      creator: chatAvatarId(''),
      title: '',
      moderators: [],
      invitees: [],
    };
    const bytes = encodeMessage(new ChatRoomList([room]));
    // Layout:
    //   header             6
    //   array count u32    4 (= 1)
    //   id u32             4 (01 00 00 00)
    //   roomType u32       4 (00 00 00 00)
    //   moderated u8       1 (00)
    //   path stdString u16 2 (00 00)
    //   owner CAI          6
    //   creator CAI        6
    //   title uString u32  4 (00 00 00 00)
    //   moderator i32 cnt  4 (00 00 00 00)
    //   invitee i32 cnt    4 (00 00 00 00)
    expect(bytes.length).toBe(6 + 4 + 4 + 4 + 1 + 2 + 6 + 6 + 4 + 4 + 4);

    // array count at offset 6
    expect(bytes[6]).toBe(0x01);
    expect(bytes[10]).toBe(0x01); // room.id at offset 10
    expect(bytes[14]).toBe(0x00); // room.roomType at offset 14
    expect(bytes[18]).toBe(0x00); // moderated at offset 18
    // path length u16 at offsets 19/20
    expect(bytes[19]).toBe(0x00);
    expect(bytes[20]).toBe(0x00);
  });
});
