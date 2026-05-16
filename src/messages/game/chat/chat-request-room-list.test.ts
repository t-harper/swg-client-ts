import { describe, expect, it } from 'vitest';

import { ByteStream } from '../../../archive/byte-stream.js';
import { ReadIterator } from '../../../archive/read-iterator.js';
import { encodeMessage, parseHeader } from '../../base.js';
import { messageRegistry } from '../../registry.js';
import { ChatRequestRoomList } from './chat-request-room-list.js';

import './chat-request-room-list.js';

describe('ChatRequestRoomList', () => {
  it('has the expected metadata', () => {
    expect(ChatRequestRoomList.messageName).toBe('ChatRequestRoomList');
    expect(ChatRequestRoomList.varCount).toBe(1);
    expect(ChatRequestRoomList.typeCrc).toBeGreaterThan(0);
  });

  it('encodes to empty payload', () => {
    const s = new ByteStream();
    new ChatRequestRoomList().encodePayload(s);
    expect(s.toBytes().length).toBe(0);
  });

  it('decodes empty', () => {
    const d = ChatRequestRoomList.decodePayload(new ReadIterator(new Uint8Array(0)));
    expect(d).toBeInstanceOf(ChatRequestRoomList);
  });

  it('full encode is exactly 6 bytes (varCount + typeCrc) with no payload', () => {
    const bytes = encodeMessage(new ChatRequestRoomList());
    expect(bytes.length).toBe(6);
    // varCount = 1
    expect(bytes[0]).toBe(0x01);
    expect(bytes[1]).toBe(0x00);

    const { varCount, typeCrc, payload } = parseHeader(bytes);
    expect(varCount).toBe(1);
    expect(typeCrc).toBe(ChatRequestRoomList.typeCrc);
    expect(payload.remaining).toBe(0);

    const decoder = messageRegistry.getByCrc(typeCrc);
    expect(decoder).toBeDefined();
  });
});
