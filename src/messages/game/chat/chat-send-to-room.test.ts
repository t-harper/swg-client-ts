import { describe, expect, it } from 'vitest';

import { encodeMessage, parseHeader } from '../../base.js';
import { messageRegistry } from '../../registry.js';
import { ChatSendToRoom } from './chat-send-to-room.js';

import './chat-send-to-room.js';

describe('ChatSendToRoom', () => {
  it('has the expected metadata', () => {
    expect(ChatSendToRoom.messageName).toBe('ChatSendToRoom');
    expect(ChatSendToRoom.varCount).toBe(5);
    expect(ChatSendToRoom.typeCrc).toBeGreaterThan(0);
  });

  it('round-trips encode → decode', () => {
    const original = new ChatSendToRoom(99, 12, 'hi room', 'oob-data');
    const bytes = encodeMessage(original);

    const { varCount, typeCrc, payload } = parseHeader(bytes);
    expect(varCount).toBe(5);
    expect(typeCrc).toBe(ChatSendToRoom.typeCrc);

    const decoder = messageRegistry.getByCrc(typeCrc);
    if (!decoder) throw new Error('decoder missing');
    const decoded = decoder.decodePayload(payload);
    expect(decoded).toBeInstanceOf(ChatSendToRoom);
    if (!(decoded instanceof ChatSendToRoom)) throw new Error('typeguard');

    expect(decoded.sequence).toBe(99);
    expect(decoded.roomId).toBe(12);
    expect(decoded.message).toBe('hi room');
    expect(decoded.outOfBand).toBe('oob-data');
  });

  it('writes fields in message, outOfBand, roomId, sequence order', () => {
    // Pick message='a', oob='b', roomId=2, sequence=3 — distinctive byte values.
    const bytes = encodeMessage(new ChatSendToRoom(3, 2, 'a', 'b'));
    // Header(6) +
    //   message uString: u32 cnt=1 + 'a' UTF-16 LE = 6
    //   oob uString:     u32 cnt=1 + 'b' UTF-16 LE = 6
    //   roomId u32 = 4
    //   sequence u32 = 4
    // Total = 26
    expect(bytes.length).toBe(26);

    // varCount = 5 LE
    expect(bytes[0]).toBe(0x05);

    // message u32 count = 1 LE at offset 6
    expect(bytes[6]).toBe(0x01);
    expect(bytes[7]).toBe(0x00);
    expect(bytes[8]).toBe(0x00);
    expect(bytes[9]).toBe(0x00);
    // UTF-16 LE 'a' at 10/11
    expect(bytes[10]).toBe(0x61);
    expect(bytes[11]).toBe(0x00);

    // oob u32 count = 1 LE at offset 12
    expect(bytes[12]).toBe(0x01);
    // UTF-16 LE 'b' at 16/17
    expect(bytes[16]).toBe(0x62);
    expect(bytes[17]).toBe(0x00);

    // roomId u32 = 2 LE at offset 18
    expect(bytes[18]).toBe(0x02);
    expect(bytes[19]).toBe(0x00);

    // sequence u32 = 3 LE at offset 22
    expect(bytes[22]).toBe(0x03);
    expect(bytes[23]).toBe(0x00);
  });
});
