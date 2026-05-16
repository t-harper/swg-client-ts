import { describe, expect, it } from 'vitest';

import { encodeMessage, parseHeader } from '../../base.js';
import { messageRegistry } from '../../registry.js';
import { chatAvatarId } from './chat-avatar-id.js';
import {
  ChatPersistentMessageToServer,
  PERSISTENT_MESSAGE_MAX_SIZE,
} from './chat-persistent-message-to-server.js';

import './chat-persistent-message-to-server.js';

describe('ChatPersistentMessageToServer', () => {
  it('has the expected metadata', () => {
    expect(ChatPersistentMessageToServer.messageName).toBe('ChatPersistentMessageToServer');
    expect(ChatPersistentMessageToServer.varCount).toBe(6);
    expect(ChatPersistentMessageToServer.typeCrc).toBeGreaterThan(0);
  });

  it('round-trips encode → decode', () => {
    const original = new ChatPersistentMessageToServer(
      77,
      chatAvatarId('leia', 'swg', 'SWG'),
      'a subject',
      'a body',
      '',
    );
    const bytes = encodeMessage(original);

    const { varCount, typeCrc, payload } = parseHeader(bytes);
    expect(varCount).toBe(6);
    expect(typeCrc).toBe(ChatPersistentMessageToServer.typeCrc);

    const decoder = messageRegistry.getByCrc(typeCrc);
    if (!decoder) throw new Error('decoder missing');
    const decoded = decoder.decodePayload(payload);
    expect(decoded).toBeInstanceOf(ChatPersistentMessageToServer);
    if (!(decoded instanceof ChatPersistentMessageToServer)) throw new Error('typeguard');

    expect(decoded.sequence).toBe(77);
    expect(decoded.toCharacterName).toEqual({ gameCode: 'SWG', cluster: 'swg', name: 'leia' });
    expect(decoded.subject).toBe('a subject');
    expect(decoded.message).toBe('a body');
    expect(decoded.outOfBand).toBe('');
  });

  it('truncates messages over MAX_MESSAGE_SIZE to mirror the C++ ctor', () => {
    const huge = 'x'.repeat(PERSISTENT_MESSAGE_MAX_SIZE + 100);
    const msg = new ChatPersistentMessageToServer(1, chatAvatarId('y'), 's', huge, '');
    expect(msg.message.length).toBe(PERSISTENT_MESSAGE_MAX_SIZE);
  });

  it('writes fields in message, outOfBand, sequence, subject, toCharacterName order', () => {
    // Empty avatars / strings for a deterministic minimal layout.
    const bytes = encodeMessage(new ChatPersistentMessageToServer(1, chatAvatarId(''), '', '', ''));
    // Header(6) + 3 empty u32-prefixed UnicodeStrings (4 + 4 + 4)
    //   + sequence u32 (4) + 3 empty stdStrings for the avatar (6)
    // Order: message uString | oob uString | sequence u32 | subject uString | avatar
    // = 6 + 4 + 4 + 4 + 4 + 6 = 28
    expect(bytes.length).toBe(28);
    // varCount = 6
    expect(bytes[0]).toBe(0x06);
    expect(bytes[1]).toBe(0x00);
    // sequence = 1 LE — located at offset 6 + 4 (message len) + 4 (oob len) = 14
    expect(bytes[14]).toBe(0x01);
    expect(bytes[15]).toBe(0x00);
    expect(bytes[16]).toBe(0x00);
    expect(bytes[17]).toBe(0x00);
  });
});
