import { describe, expect, it } from 'vitest';

import { encodeMessage, parseHeader } from '../../base.js';
import { messageRegistry } from '../../registry.js';
import { chatAvatarId } from './chat-avatar-id.js';
import { ChatInstantMessageToClient } from './chat-instant-message-to-client.js';

import './chat-instant-message-to-client.js';

describe('ChatInstantMessageToClient', () => {
  it('has the expected metadata', () => {
    expect(ChatInstantMessageToClient.messageName).toBe('ChatInstantMessageToClient');
    expect(ChatInstantMessageToClient.varCount).toBe(4);
    expect(ChatInstantMessageToClient.typeCrc).toBeGreaterThan(0);
  });

  it('round-trips encode → decode', () => {
    const original = new ChatInstantMessageToClient(
      chatAvatarId('leia', 'swg', 'SWG'),
      'help!',
      '',
    );
    const bytes = encodeMessage(original);

    const { varCount, typeCrc, payload } = parseHeader(bytes);
    expect(varCount).toBe(4);
    expect(typeCrc).toBe(ChatInstantMessageToClient.typeCrc);

    const decoder = messageRegistry.getByCrc(typeCrc);
    if (!decoder) throw new Error('decoder missing');
    const decoded = decoder.decodePayload(payload);
    expect(decoded).toBeInstanceOf(ChatInstantMessageToClient);
    if (!(decoded instanceof ChatInstantMessageToClient)) throw new Error('typeguard');

    expect(decoded.fromName).toEqual({ gameCode: 'SWG', cluster: 'swg', name: 'leia' });
    expect(decoded.message).toBe('help!');
    expect(decoded.outOfBand).toBe('');
  });

  it('has the exact byte layout we expect', () => {
    const msg = new ChatInstantMessageToClient(chatAvatarId(''), '', '');
    const bytes = encodeMessage(msg);
    // Header: 6
    // ChatAvatarId empty: 6 (three u16 zero prefixes)
    // message empty: u32 = 4
    // outOfBand empty: u32 = 4
    // Total = 20
    expect(bytes.length).toBe(20);

    // varCount = 4 LE
    expect(bytes[0]).toBe(0x04);
    expect(bytes[1]).toBe(0x00);
  });
});
