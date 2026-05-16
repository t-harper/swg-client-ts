import { describe, expect, it } from 'vitest';

import { encodeMessage, parseHeader } from '../../base.js';
import { messageRegistry } from '../../registry.js';
import { chatAvatarId } from './chat-avatar-id.js';
import { ChatInstantMessageToCharacter } from './chat-instant-message-to-character.js';

// Side-effect import (registers decoder)
import './chat-instant-message-to-character.js';

describe('ChatInstantMessageToCharacter', () => {
  it('has the expected metadata', () => {
    expect(ChatInstantMessageToCharacter.messageName).toBe('ChatInstantMessageToCharacter');
    expect(ChatInstantMessageToCharacter.varCount).toBe(5);
    expect(ChatInstantMessageToCharacter.typeCrc).toBeGreaterThan(0);
  });

  it('round-trips encode → decode', () => {
    const original = new ChatInstantMessageToCharacter(
      chatAvatarId('han', 'swg', 'SWG'),
      'hi there',
      '',
      42,
    );
    const bytes = encodeMessage(original);

    const { varCount, typeCrc, payload } = parseHeader(bytes);
    expect(varCount).toBe(5);
    expect(typeCrc).toBe(ChatInstantMessageToCharacter.typeCrc);

    const decoder = messageRegistry.getByCrc(typeCrc);
    if (!decoder) throw new Error('decoder missing');
    const decoded = decoder.decodePayload(payload);
    expect(decoded).toBeInstanceOf(ChatInstantMessageToCharacter);
    if (!(decoded instanceof ChatInstantMessageToCharacter)) throw new Error('typeguard');

    expect(decoded.characterName).toEqual({ gameCode: 'SWG', cluster: 'swg', name: 'han' });
    expect(decoded.message).toBe('hi there');
    expect(decoded.outOfBand).toBe('');
    expect(decoded.sequence).toBe(42);
  });

  it('has the exact byte layout we expect', () => {
    // Minimal: empty avatar (3 empty stdStrings = 6 bytes), 1-char message,
    // empty oob, sequence=1.
    const msg = new ChatInstantMessageToCharacter(chatAvatarId(''), 'a', '', 1);
    const bytes = encodeMessage(msg);
    // Header: varCount=5 (u16 LE) + typeCrc (u32 LE) = 6 bytes
    // characterName empty: 3 * (u16 len=0) = 6 bytes
    // message "a": u32 char-count=1 (4 bytes) + 2 bytes UTF-16 LE 'a' = 6 bytes
    // outOfBand empty: u32 char-count=0 (4 bytes)
    // sequence: u32 LE = 4 bytes
    // Total = 6 + 6 + 6 + 4 + 4 = 26 bytes
    expect(bytes.length).toBe(26);

    // varCount = 5 LE
    expect(bytes[0]).toBe(0x05);
    expect(bytes[1]).toBe(0x00);

    // After 6-byte header and 6-byte empty avatar (offset 12):
    //   u32 char-count = 1 (01 00 00 00)
    expect(bytes[12]).toBe(0x01);
    expect(bytes[13]).toBe(0x00);
    expect(bytes[14]).toBe(0x00);
    expect(bytes[15]).toBe(0x00);
    // UTF-16 LE 'a' = 61 00
    expect(bytes[16]).toBe(0x61);
    expect(bytes[17]).toBe(0x00);
    // OOB length = 0 (00 00 00 00) at offset 18-21
    expect(bytes[18]).toBe(0x00);
    expect(bytes[21]).toBe(0x00);
    // sequence = 1 LE at offset 22-25
    expect(bytes[22]).toBe(0x01);
    expect(bytes[23]).toBe(0x00);
    expect(bytes[24]).toBe(0x00);
    expect(bytes[25]).toBe(0x00);
  });

  it('preserves Unicode (UTF-16 LE) message content', () => {
    // Pick a BMP character — '★' = U+2605
    const msg = new ChatInstantMessageToCharacter(chatAvatarId('me'), '★', '', 0);
    const bytes = encodeMessage(msg);
    const { payload } = parseHeader(bytes);
    const decoded = ChatInstantMessageToCharacter.decodePayload(payload);
    expect(decoded.message).toBe('★');
    expect(decoded.message.length).toBe(1);
  });
});
